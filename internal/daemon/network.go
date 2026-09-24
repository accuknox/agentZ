package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"

	"github.com/accuknox/agentz/internal/sandboxutil"
)

// NativeNetworkNamespace contains only native workload networking. The daemon's
// authenticated backend connection and the host's other applications stay out.
const NativeNetworkNamespace = "agentz"

const networkTable = "agentz_native"

type dnsCacheKey struct {
	question dns.Question
	dnssec   bool
}

type dnsCacheEntry struct {
	answer  *dns.Msg
	created time.Time
	ttl     time.Duration
}

// Network applies sandbox allowedHosts to direct TCP/UDP and controlled DNS.
// Kernel rules survive daemon restarts; Close stops DNS without opening egress.
type Network struct {
	mu         sync.RWMutex
	hosts      []sandboxutil.Host
	generation uint64
	cache      map[dnsCacheKey]dnsCacheEntry
	upstreams  []string
	udp        *dns.Server
	tcp        *dns.Server
	queries    chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewNetwork installs a default-deny namespace before configuring routes, then
// starts its DNS service. It never flushes another host application's rules.
func NewNetwork(ctx context.Context, allowedHosts []string) (*Network, error) {
	if os.Geteuid() != 0 {
		return nil, fmt.Errorf("native network setup requires root")
	}
	for _, program := range []string{"ip", "nft"} {
		if _, err := exec.LookPath(program); err != nil {
			return nil, fmt.Errorf("native network prerequisite %s: %w", program, err)
		}
	}
	resolver, err := dns.ClientConfigFromFile("/etc/resolv.conf")
	if err != nil || len(resolver.Servers) == 0 {
		return nil, fmt.Errorf("native DNS requires a host resolver: %v", err)
	}
	lifetime, cancel := context.WithCancel(ctx)
	n := &Network{queries: make(chan struct{}, 32), ctx: lifetime, cancel: cancel}
	for _, server := range resolver.Servers {
		n.upstreams = append(n.upstreams, net.JoinHostPort(server, resolver.Port))
	}
	_, namespaceErr := os.Stat("/run/netns/" + NativeNetworkNamespace)
	_, markerErr := os.Stat("/run/agentz/native-network")
	if namespaceErr == nil && markerErr != nil {
		cancel()
		return nil, fmt.Errorf("refuse to adopt an unowned agentz network namespace")
	}
	namespaceMissing := errors.Is(namespaceErr, os.ErrNotExist)
	if namespaceMissing {
		if err := networkCommand(ctx, "", "ip", "link", "show", "agentz-host"); err == nil {
			cancel()
			return nil, fmt.Errorf("refuse to adopt an existing agentz-host interface")
		}
		if err := os.MkdirAll("/run/agentz", 0755); err != nil {
			cancel()
			return nil, err
		}
		if err := networkCommand(ctx, "", "ip", "netns", "add", NativeNetworkNamespace); err != nil {
			cancel()
			return nil, err
		}
		if err := os.WriteFile("/run/agentz/native-network", []byte("1\n"), 0600); err != nil {
			cancel()
			return nil, err
		}
	}
	if namespaceErr != nil && !namespaceMissing {
		cancel()
		return nil, namespaceErr
	}
	if err := n.Update(ctx, allowedHosts); err != nil {
		cancel()
		return nil, err
	}
	// Namespace policy is already installed before either end of the veth is up.
	if err := networkCommand(ctx, "", "ip", "link", "show", "agentz-host"); err != nil {
		err := networkCommand(
			ctx, "", "ip", "link", "add", "agentz-host", "type", "veth",
			"peer", "name", "agentz-peer", "netns", NativeNetworkNamespace,
		)
		if err != nil {
			cancel()
			return nil, err
		}
	}
	commands := [][]string{
		{"ip", "address", "replace", "169.254.240.1/30", "dev", "agentz-host"},
		{"ip", "-6", "address", "replace", "fd41:6765:6e74::1/126", "dev", "agentz-host", "nodad"},
		{
			"ip", "-n", NativeNetworkNamespace, "address", "replace",
			"169.254.240.2/30", "dev", "agentz-peer",
		},
		{
			"ip", "-n", NativeNetworkNamespace, "-6", "address", "replace",
			"fd41:6765:6e74::2/126", "dev", "agentz-peer", "nodad",
		},
		{"ip", "link", "set", "agentz-host", "up"},
		{"ip", "-n", NativeNetworkNamespace, "link", "set", "lo", "up"},
		{"ip", "-n", NativeNetworkNamespace, "link", "set", "agentz-peer", "up"},
		{"ip", "-n", NativeNetworkNamespace, "route", "replace", "default", "via", "169.254.240.1"},
		{
			"ip", "-n", NativeNetworkNamespace, "-6", "route", "replace",
			"default", "via", "fd41:6765:6e74::1",
		},
	}
	for _, args := range commands {
		if err := networkCommand(ctx, "", args[0], args[1:]...); err != nil {
			cancel()
			return nil, err
		}
	}
	// Only the owned veth's packets are NATed; existing host tables stay intact.
	hostRules := `add table inet agentz_native
 delete table inet agentz_native
 table inet agentz_native {
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
  iifname "agentz-host" ip saddr 169.254.240.2 masquerade
  iifname "agentz-host" ip6 saddr fd41:6765:6e74::2 masquerade
 }
 chain forward { type filter hook forward priority filter; policy accept;
  oifname "agentz-host" ct state established,related accept
  oifname "agentz-host" drop
 }
 }
`
	if err := networkCommand(ctx, hostRules, "nft", "-f", "-"); err != nil {
		cancel()
		return nil, err
	}
	// Router mode normally disables IPv6 router-advertisement acceptance.
	// Preserve existing receiver behavior for current and future host links.
	forwarding, err := os.ReadFile("/proc/sys/net/ipv6/conf/all/forwarding")
	if err != nil {
		cancel()
		return nil, fmt.Errorf("read IPv6 forwarding prerequisite: %w", err)
	}
	if strings.TrimSpace(string(forwarding)) != "1" {
		files, err := filepath.Glob("/proc/sys/net/ipv6/conf/*/accept_ra")
		if err != nil {
			cancel()
			return nil, err
		}
		for _, file := range files {
			value, err := os.ReadFile(file)
			if err != nil {
				cancel()
				return nil, err
			}
			if strings.TrimSpace(string(value)) == "1" {
				if err := os.WriteFile(file, []byte("2\n"), 0644); err != nil {
					cancel()
					return nil, fmt.Errorf("preserve host IPv6 advertisements: %w", err)
				}
			}
		}
	}
	forwardingFiles := []string{
		"/proc/sys/net/ipv4/ip_forward",
		"/proc/sys/net/ipv6/conf/all/forwarding",
	}
	for _, file := range forwardingFiles {
		value, err := os.ReadFile(file)
		if err != nil {
			cancel()
			return nil, err
		}
		if strings.TrimSpace(string(value)) == "1" {
			continue
		}
		if err := os.WriteFile(file, []byte("1\n"), 0644); err != nil {
			cancel()
			return nil, fmt.Errorf("enable native forwarding %s: %w", file, err)
		}
	}
	if err := os.MkdirAll("/etc/netns/agentz", 0755); err != nil {
		cancel()
		return nil, err
	}
	resolverConfig := []byte("nameserver 127.0.0.53\noptions timeout:2 attempts:2\n")
	if err := os.WriteFile("/etc/netns/agentz/resolv.conf", resolverConfig, 0644); err != nil {
		cancel()
		return nil, err
	}
	var udp net.PacketConn
	var tcp net.Listener
	err = inNamespace(func() error {
		var err error
		udp, err = net.ListenPacket("udp4", "127.0.0.53:53")
		if err != nil {
			return err
		}
		tcp, err = net.Listen("tcp4", "127.0.0.53:53")
		if err != nil {
			_ = udp.Close()
		}
		return err
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("bind native DNS: %w", err)
	}
	n.udp = &dns.Server{PacketConn: udp, Handler: dns.HandlerFunc(n.serveDNS), UDPSize: 1232}
	n.tcp = &dns.Server{
		Listener:      tcp,
		Handler:       dns.HandlerFunc(n.serveDNS),
		MaxTCPQueries: 64,
		ReadTimeout:   5 * time.Second,
		WriteTimeout:  5 * time.Second,
	}
	for _, server := range []*dns.Server{n.udp, n.tcp} {
		go func() {
			if err := server.ActivateAndServe(); err != nil && n.ctx.Err() == nil {
				slog.ErrorContext(n.ctx, "native DNS stopped", "err", err)
				// Stop allowing fresh direct connections when the resolver fails.
				_ = n.Update(context.Background(), nil)
			}
		}()
	}
	return n, nil
}

// Update atomically replaces the entire owned namespace policy. DNS results
// resolved under an earlier generation cannot authorize a newer policy.
func (n *Network) Update(ctx context.Context, allowedHosts []string) error {
	hosts, err := sandboxutil.ParseHostList(allowedHosts)
	if err != nil {
		return err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	err = networkCommand(
		ctx, nativeRules(hosts),
		"ip", "netns", "exec", NativeNetworkNamespace, "nft", "-f", "-",
	)
	if err != nil {
		return err
	}
	n.hosts = hosts
	n.generation++
	n.cache = make(map[dnsCacheKey]dnsCacheEntry)
	return nil
}

// Close shuts down DNS and leaves the workload firewall in place.
func (n *Network) Close() error {
	n.cancel()
	return errors.Join(n.udp.Shutdown(), n.tcp.Shutdown())
}

func nativeRules(hosts []sandboxutil.Host) string {
	var ipv4, ipv6 []string
	for _, host := range hosts {
		if host.Kind != sandboxutil.HostKindCIDR {
			continue
		}
		prefix, _ := netip.ParsePrefix(host.Value)
		if prefix.Addr().Is4() {
			ipv4 = append(ipv4, host.Value)
			continue
		}
		ipv6 = append(ipv6, host.Value)
	}
	var rules strings.Builder
	rules.WriteString(`add table inet agentz_native
 delete table inet agentz_native
 table inet agentz_native {
 set dns4 { type ipv4_addr; flags timeout; size 8192; }
 set dns6 { type ipv6_addr; flags timeout; size 8192; }
 chain output { type filter hook output priority filter; policy drop;
  oifname "lo" accept
  meta l4proto 58 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
  ip daddr @dns4 accept
  ip6 daddr @dns6 accept
`)
	for _, cidr := range ipv4 {
		fmt.Fprintf(&rules, "  ip daddr %s accept\n", cidr)
	}
	for _, cidr := range ipv6 {
		fmt.Fprintf(&rules, "  ip6 daddr %s accept\n", cidr)
	}
	rules.WriteString(`  counter drop
 }
 chain input { type filter hook input priority filter; policy drop;
  iifname "lo" accept
  ct state established,related accept
  meta l4proto 58 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
 }
 }
`)
	return rules.String()
}

func allowedDNS(hosts []sandboxutil.Host, name string) bool {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	for _, host := range hosts {
		switch host.Kind {
		case sandboxutil.HostKindDomain:
			if name == host.Value {
				return true
			}
		case sandboxutil.HostKindWildcard, sandboxutil.HostKindDeepWildcard:
			suffix := strings.TrimPrefix(strings.TrimPrefix(host.Value, "**"), "*")
			prefix, ok := strings.CutSuffix(name, suffix)
			deepMatch := host.Kind == sandboxutil.HostKindDeepWildcard
			if ok && prefix != "" && (deepMatch || !strings.Contains(prefix, ".")) {
				return true
			}
		}
	}
	return false
}

func (n *Network) serveDNS(w dns.ResponseWriter, request *dns.Msg) {
	response := new(dns.Msg)
	response.SetRcode(request, dns.RcodeRefused)
	validQuestion := len(request.Question) == 1 && request.Opcode == dns.OpcodeQuery
	if !validQuestion || request.Question[0].Qclass != dns.ClassINET {
		_ = w.WriteMsg(response)
		return
	}
	question := request.Question[0]
	key := dnsCacheKey{question: question}
	key.question.Name = strings.ToLower(question.Name)
	if option := request.IsEdns0(); option != nil {
		key.dnssec = option.Do()
	}
	n.mu.RLock()
	allowed, generation := allowedDNS(n.hosts, question.Name), n.generation
	cached, found := n.cache[key]
	n.mu.RUnlock()
	if !allowed {
		_ = w.WriteMsg(response)
		return
	}
	if found && time.Since(cached.created) < cached.ttl {
		answer := cached.answer.Copy()
		answer.Id = request.Id
		answer.Question = request.Question
		age := uint32(time.Since(cached.created) / time.Second)
		for _, section := range [][]dns.RR{answer.Answer, answer.Ns, answer.Extra} {
			for _, record := range section {
				if record.Header().Rrtype != dns.TypeOPT {
					record.Header().Ttl -= min(record.Header().Ttl, age)
				}
			}
		}
		_ = w.WriteMsg(answer)
		return
	}
	select {
	case n.queries <- struct{}{}:
		defer func() { <-n.queries }()
	default:
		response.SetRcode(request, dns.RcodeServerFailure)
		_ = w.WriteMsg(response)
		return
	}
	ctx, cancel := context.WithTimeout(n.ctx, 5*time.Second)
	defer cancel()
	client := &dns.Client{Net: "udp", Timeout: 2 * time.Second, UDPSize: 1232}
	var answer *dns.Msg
	for _, upstream := range n.upstreams {
		var err error
		answer, _, err = client.ExchangeContext(ctx, request, upstream)
		if err != nil {
			answer = nil
			continue
		}
		if answer.Truncated {
			tcp := &dns.Client{Net: "tcp", Timeout: 2 * time.Second}
			answer, _, err = tcp.ExchangeContext(ctx, request, upstream)
		}
		if err == nil {
			break
		}
		answer = nil
	}
	if answer == nil {
		response.SetRcode(request, dns.RcodeServerFailure)
		_ = w.WriteMsg(response)
		return
	}
	n.mu.Lock()
	if n.generation != generation {
		n.mu.Unlock()
		_ = w.WriteMsg(response)
		return
	}
	// Only final addresses belonging to the requested name's CNAME chain can
	// authorize egress. Additional/unrelated answer records never grant access.
	addresses := dnsAddresses(question.Name, answer.Answer)
	var script strings.Builder
	for address, ttl := range addresses {
		set := "dns6"
		if address.Is4() {
			set = "dns4"
		}
		element := fmt.Sprintf("%s timeout %ds", address, max(ttl, 1))
		// add/delete/add refreshes an existing timeout without requiring a
		// userspace lifetime cache or newer nft destroy-element support.
		fmt.Fprintf(&script, "add element inet %s %s { %s }\n", networkTable, set, element)
		fmt.Fprintf(&script, "delete element inet %s %s { %s }\n", networkTable, set, address)
		fmt.Fprintf(&script, "add element inet %s %s { %s }\n", networkTable, set, element)
	}
	if script.Len() > 0 {
		err := networkCommand(
			ctx, script.String(),
			"ip", "netns", "exec", NativeNetworkNamespace, "nft", "-f", "-",
		)
		if err != nil {
			n.mu.Unlock()
			slog.WarnContext(ctx, "native DNS could not authorize response", "err", err)
			response.SetRcode(request, dns.RcodeServerFailure)
			_ = w.WriteMsg(response)
			return
		}
	}
	if answer.Rcode == dns.RcodeSuccess && len(answer.Answer) > 0 {
		ttl := uint32(3600)
		for _, section := range [][]dns.RR{answer.Answer, answer.Ns, answer.Extra} {
			for _, record := range section {
				if record.Header().Rrtype != dns.TypeOPT {
					ttl = min(ttl, record.Header().Ttl)
				}
			}
		}
		if len(n.cache) >= 1024 {
			for key, entry := range n.cache {
				if time.Since(entry.created) >= entry.ttl {
					delete(n.cache, key)
				}
			}
		}
		if ttl > 0 && len(n.cache) < 1024 {
			n.cache[key] = dnsCacheEntry{
				answer: answer.Copy(), created: time.Now(),
				ttl: time.Duration(ttl) * time.Second,
			}
		}
	}
	n.mu.Unlock()
	_ = w.WriteMsg(answer)
}

func dnsAddresses(name string, answers []dns.RR) map[netip.Addr]uint32 {
	name = strings.ToLower(dns.Fqdn(name))
	chain := map[string]uint32{name: ^uint32(0)}
	for range 16 {
		changed := false
		for _, record := range answers {
			alias, ok := record.(*dns.CNAME)
			if !ok {
				continue
			}
			ttl, ok := chain[strings.ToLower(alias.Hdr.Name)]
			if !ok {
				continue
			}
			target := strings.ToLower(alias.Target)
			if _, exists := chain[target]; !exists {
				chain[target] = min(ttl, alias.Hdr.Ttl)
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	addresses := make(map[netip.Addr]uint32)
	for _, record := range answers {
		ttl, ok := chain[strings.ToLower(record.Header().Name)]
		if !ok {
			continue
		}
		var ip net.IP
		switch record := record.(type) {
		case *dns.A:
			ip = record.A
		case *dns.AAAA:
			ip = record.AAAA
		default:
			continue
		}
		address, ok := netip.AddrFromSlice(ip)
		if ok {
			addresses[address.Unmap()] = min(ttl, record.Header().Ttl)
		}
	}
	return addresses
}

func networkCommand(ctx context.Context, input string, program string, args ...string) error {
	installed := filepath.Join("/var/lib/agentz/runtime/tools/bin", program)
	info, err := os.Stat(installed)
	if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
		program = installed
	}
	command := exec.CommandContext(ctx, program, args...)
	if input != "" {
		command.Stdin = strings.NewReader(input)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf(
			"native network %s %s: %w: %s",
			program, strings.Join(args, " "), err, strconv.Quote(string(output)),
		)
	}
	return nil
}
