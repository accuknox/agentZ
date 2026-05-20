package observer

import (
	"context"
	"strings"
	"sync"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
)

const (
	protocolICMPv4 = "ICMPv4"
	protocolICMPv6 = "ICMPv6"
	protocolIGMP   = "IGMP"
	protocolSCTP   = "SCTP"
	protocolTCP    = "TCP"
	protocolUDP    = "UDP"
	protocolVRRP   = "VRRP"
)

type managedSource struct {
	agentName string
	namespace string
	podName   string
}

type dnsCacheKey struct {
	agentName string
	podName   string
	ip        string
}

type dnsCacheEntry struct {
	domain   string
	deadline time.Time
}

type dnsCache struct {
	mu    sync.Mutex
	items map[dnsCacheKey]dnsCacheEntry
}

func newDNSCache() *dnsCache {
	return &dnsCache{items: map[dnsCacheKey]dnsCacheEntry{}}
}

func (c *dnsCache) put(agentName, podName, ip, domain string, now time.Time, ttl uint32) {
	if agentName == "" || podName == "" || ip == "" || domain == "" {
		return
	}

	d := time.Duration(ttl) * time.Second
	if d <= 0 {
		d = 5 * time.Minute
	}
	if d > time.Hour {
		d = time.Hour
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[dnsCacheKey{agentName: agentName, podName: podName, ip: ip}] = dnsCacheEntry{
		domain:   domain,
		deadline: now.Add(d),
	}
}

func (c *dnsCache) get(agentName, podName, ip string, now time.Time) string {
	if agentName == "" || podName == "" || ip == "" {
		return ""
	}

	key := dnsCacheKey{agentName: agentName, podName: podName, ip: ip}
	c.mu.Lock()
	defer c.mu.Unlock()

	item, ok := c.items[key]
	if !ok {
		return ""
	}
	if !item.deadline.After(now) {
		delete(c.items, key)
		return ""
	}
	return item.domain
}

func normalizeFlow(ctx context.Context, item *flowpb.Flow, namespace string, r *resolver, cache *dnsCache) (event, bool) {
	if item == nil {
		return event{}, false
	}

	src, ok := resolveManagedSource(ctx, r, item.GetSource())
	if !ok {
		return event{}, false
	}

	ts := flowEventTime(item)
	observeDNSFlow(item, src, cache, ts)

	if src.namespace != namespace {
		return event{}, false
	}
	if item.GetTrafficDirection() != flowpb.TrafficDirection_EGRESS {
		return event{}, false
	}
	if reply := item.GetIsReply(); reply != nil && reply.GetValue() {
		return event{}, false
	}

	action, ok := normalizeNetworkAction(item.GetVerdict())
	if !ok {
		return event{}, false
	}
	protocol, port := normalizeNetworkProtocol(item.GetL4())
	if protocol == "" {
		return event{}, false
	}

	dstIP := strings.TrimSpace(item.GetIP().GetDestination())
	domain := normalizeDestinationDomain(
		cache.get(src.agentName, src.podName, dstIP, ts),
		item.GetDestinationNames(),
		r.resolveDestinationDomain(ctx, dstIP),
	)

	return event{network: &networkEvent{
		agentName:         src.agentName,
		eventTime:         ts,
		podNamespace:      src.namespace,
		podName:           src.podName,
		destinationDomain: domain,
		destinationIP:     dstIP,
		destinationPort:   port,
		protocol:          protocol,
		action:            action,
		source:            sourceHubble,
	}}, true
}

func observeDNSFlow(item *flowpb.Flow, src managedSource, cache *dnsCache, now time.Time) {
	if cache == nil || item.GetL7().GetDns() == nil {
		return
	}

	dns := item.GetL7().GetDns()
	domain := normalizeDNSName(dns.GetQuery())
	if domain == "" {
		return
	}
	for _, ip := range dns.GetIps() {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			continue
		}
		cache.put(src.agentName, src.podName, ip, domain, now, dns.GetTtl())
	}
}

func resolveManagedSource(ctx context.Context, r *resolver, src *flowpb.Endpoint) (managedSource, bool) {
	if src == nil {
		return managedSource{}, false
	}

	labels := normalizeHubbleLabels(src.GetLabels())
	agentName, ok := r.resolveNetwork(ctx, src.GetNamespace(), labels, src.GetPodName())
	if !ok {
		return managedSource{}, false
	}
	return managedSource{
		agentName: agentName,
		namespace: src.GetNamespace(),
		podName:   src.GetPodName(),
	}, true
}

func normalizeHubbleLabels(raw []string) map[string]string {
	labels := make(map[string]string, len(raw))
	for _, item := range raw {
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" {
			continue
		}
		key = strings.TrimPrefix(key, "k8s:")
		labels[key] = value
	}
	return labels
}

func normalizeNetworkAction(verdict flowpb.Verdict) (string, bool) {
	switch verdict {
	case flowpb.Verdict_FORWARDED, flowpb.Verdict_AUDIT:
		return actionAllowed, true
	case flowpb.Verdict_DROPPED:
		return actionBlocked, true
	default:
		return "", false
	}
}

func normalizeNetworkProtocol(l4 *flowpb.Layer4) (string, int64) {
	if l4 == nil {
		return "", 0
	}

	switch item := l4.Protocol.(type) {
	case *flowpb.Layer4_TCP:
		return protocolTCP, int64(item.TCP.GetDestinationPort())
	case *flowpb.Layer4_UDP:
		return protocolUDP, int64(item.UDP.GetDestinationPort())
	case *flowpb.Layer4_SCTP:
		return protocolSCTP, int64(item.SCTP.GetDestinationPort())
	case *flowpb.Layer4_ICMPv4:
		return protocolICMPv4, 0
	case *flowpb.Layer4_ICMPv6:
		return protocolICMPv6, 0
	case *flowpb.Layer4_VRRP:
		return protocolVRRP, 0
	case *flowpb.Layer4_IGMP:
		return protocolIGMP, 0
	default:
		return "", 0
	}
}

func normalizeDestinationDomain(cacheDomain string, names []string, fallback string) string {
	cacheDomain = normalizeDNSName(cacheDomain)
	if cacheDomain != "" {
		return cacheDomain
	}
	for _, item := range names {
		item = normalizeDNSName(item)
		if item != "" {
			return item
		}
	}
	return normalizeDNSName(fallback)
}

func normalizeDNSName(raw string) string {
	raw = strings.TrimSpace(raw)
	return strings.TrimSuffix(raw, ".")
}

func flowEventTime(item *flowpb.Flow) time.Time {
	if item == nil || item.GetTime() == nil {
		return time.Now().UTC()
	}
	return item.GetTime().AsTime().UTC()
}
