/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package agent

import (
	"context"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (r *Reconciler) reconcileEgressPolicy(ctx context.Context, agt *agentzv1alpha1.Agent, envCfg sandboxConfig) error {
	name := egressPolicyName(agt)
	spec, err := r.buildEgressPolicySpec(agt, envCfg)
	if err != nil {
		return err
	}
	if len(spec.Egress) == 0 {
		policy := &ciliumv2.CiliumNetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: agt.Namespace},
		}
		if err := r.Delete(ctx, policy); err != nil && !apierr.IsNotFound(err) {
			return fmt.Errorf("delete egress policy: %w", err)
		}
		return nil
	}

	current := &ciliumv2.CiliumNetworkPolicy{}
	current.Name = name
	current.Namespace = agt.Namespace
	_, err = ctrlutil.CreateOrPatch(
		ctx,
		r.Client,
		current,
		func() error {
			current.Labels = resourceLabels(agt)
			current.Annotations = agt.Annotations
			current.Spec = spec
			return ctrl.SetControllerReference(agt, current, r.Scheme)
		},
	)
	if err != nil {
		return fmt.Errorf("create or patch egress policy: %w", err)
	}
	return nil
}

func (r *Reconciler) buildEgressPolicySpec(agt *agentzv1alpha1.Agent, envCfg sandboxConfig) (*ciliumapi.Rule, error) {
	hosts, err := sandboxutil.ParseHostList(envCfg.AllowedHosts)
	if err != nil {
		return nil, err
	}
	egressHosts := append([]sandboxutil.Host{}, hosts...)
	dnsHosts := append([]sandboxutil.Host{}, hosts...)
	if agt.Spec.Telemetry.Enabled {
		endpointHosts := egressHostForEndpoint(agt.Spec.Telemetry.TraceEndpoint)
		egressHosts = append(egressHosts, endpointHosts...)
		dnsHosts = append(dnsHosts, dnsHostForEndpoint(agt.Spec.Telemetry.TraceEndpoint)...)
	}
	endpointHosts := egressHostForEndpoint(r.Config.GatewayURL)
	egressHosts = append(egressHosts, endpointHosts...)
	dnsHosts = append(dnsHosts, dnsHostForEndpoint(r.Config.GatewayURL)...)
	dnsHosts = append(dnsHosts, dnsHostForEndpoint(r.proxyAddress(agt))...)
	dnsHosts = append(dnsHosts, dnsHostForEndpoint(envCfg.MCPURL)...)
	dnsHosts = append(dnsHosts, dnsHostForEndpoint(envCfg.InferenceURL)...)

	egress := buildHostEgressRules(
		uniqueHosts(egressHosts),
		uniqueHosts(dnsHosts),
	)
	egress = append(
		egress,
		serviceEgressRules(
			r.Config.GatewayURL,
			agt.Spec.Telemetry.TraceEndpoint,
		)...,
	)
	if envCfg.MCPURL != "" {
		egress = append(egress, serviceEgressRules(envCfg.MCPURL)...)
	}
	if envCfg.InferenceURL == "" {
		egress = append(egress, gatewayEgressRule(agt.Namespace, inference.GatewayName))
	}
	if envCfg.InferenceURL != "" {
		egress = append(egress, serviceEgressRules(envCfg.InferenceURL)...)
	}
	egress = append(egress, sinjectorEgressRule(agt))

	return &ciliumapi.Rule{
		EndpointSelector: ciliumapi.NewESFromLabels(
			ciliumlabels.NewLabel(
				"agentz.accuknox.com/agent",
				agt.Name,
				ciliumlabels.LabelSourceK8s,
			),
		),
		Egress: egress,
	}, nil
}

func buildHostEgressRules(hosts []sandboxutil.Host, dnsHosts []sandboxutil.Host) []ciliumapi.EgressRule {
	fqdns := ciliumapi.FQDNSelectorSlice{}
	cidrs := ciliumapi.CIDRRuleSlice{}
	for _, host := range hosts {
		switch host.Kind {
		case sandboxutil.HostKindDomain:
			fqdns = append(fqdns, ciliumapi.FQDNSelector{MatchName: host.Value})
		case sandboxutil.HostKindWildcard, sandboxutil.HostKindDeepWildcard:
			fqdns = append(fqdns, ciliumapi.FQDNSelector{MatchPattern: host.Value})
		case sandboxutil.HostKindCIDR:
			cidrs = append(cidrs, ciliumapi.CIDRRule{Cidr: ciliumapi.CIDR(host.Value)})
		}
	}

	egress := []ciliumapi.EgressRule{}
	dnsRule := dnsEgressRule(dnsHosts)
	if dnsRule != nil {
		egress = append(egress, *dnsRule)
	}
	if len(fqdns) > 0 {
		egress = append(egress, ciliumapi.EgressRule{ToFQDNs: fqdns})
	}
	if len(cidrs) > 0 {
		egress = append(
			egress,
			ciliumapi.EgressRule{
				EgressCommonRule: ciliumapi.EgressCommonRule{ToCIDRSet: cidrs},
			},
		)
	}
	return egress
}

func uniqueHosts(hosts []sandboxutil.Host) []sandboxutil.Host {
	seen := make(map[sandboxutil.Host]struct{}, len(hosts))
	out := make([]sandboxutil.Host, 0, len(hosts))
	for _, host := range hosts {
		if _, ok := seen[host]; ok {
			continue
		}
		seen[host] = struct{}{}
		out = append(out, host)
	}
	return out
}

func dnsEgressRule(hosts []sandboxutil.Host) *ciliumapi.EgressRule {
	dns := make(ciliumapi.PortRulesDNS, 0, len(hosts))
	for _, host := range hosts {
		switch host.Kind {
		case sandboxutil.HostKindDomain:
			dns = append(dns, ciliumapi.PortRuleDNS{MatchName: host.Value})
		case sandboxutil.HostKindWildcard, sandboxutil.HostKindDeepWildcard:
			dns = append(dns, ciliumapi.PortRuleDNS{MatchPattern: host.Value})
		}
	}
	if len(dns) == 0 {
		return nil
	}

	return &ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEndpoints: []ciliumapi.EndpointSelector{
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						"kube-system",
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"k8s-app",
						"kube-dns",
						ciliumlabels.LabelSourceK8s,
					),
				),
			},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{
				{Port: "53", Protocol: ciliumapi.ProtoAny},
			},
			Rules: &ciliumapi.L7Rules{
				DNS: dns,
			},
		}},
	}
}

func gatewayEgressRule(namespace, gatewayName string) ciliumapi.EgressRule {
	return ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEndpoints: []ciliumapi.EndpointSelector{
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						namespace,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"app.kubernetes.io/name",
						gatewayName,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"app.kubernetes.io/instance",
						gatewayName,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"gateway.networking.k8s.io/gateway-name",
						gatewayName,
						ciliumlabels.LabelSourceK8s,
					),
				),
			},
		},
		ToPorts: []ciliumapi.PortRule{{
			Ports: []ciliumapi.PortProtocol{{
				Port:     "80",
				Protocol: ciliumapi.ProtoTCP,
			}},
		}},
	}
}

func sinjectorEgressRule(agt *agentzv1alpha1.Agent) ciliumapi.EgressRule {
	return ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEndpoints: []ciliumapi.EndpointSelector{
				ciliumapi.NewESFromLabels(
					ciliumlabels.NewLabel(
						"io.kubernetes.pod.namespace",
						agt.Namespace,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"agentz.accuknox.com/sinjector",
						agt.Name,
						ciliumlabels.LabelSourceK8s,
					),
				),
			},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{
				{
					Port:     "4096",
					Protocol: ciliumapi.ProtoTCP,
				},
			},
		}},
	}
}

func (r *Reconciler) agentNoProxyHosts(agt *agentzv1alpha1.Agent) []string {
	rawHosts := []string{
		"127.0.0.1",
		"::1",
		"localhost",
		".cluster.local",
		".svc",
	}
	gatewayHost := endpointHost(r.Config.GatewayURL)
	if gatewayHost != "" {
		rawHosts = append(rawHosts, gatewayHost)
	}
	if agt.Spec.Telemetry.Enabled {
		host := endpointHost(agt.Spec.Telemetry.TraceEndpoint)
		if host != "" {
			rawHosts = append(rawHosts, host)
		}
	}

	seen := make(map[string]struct{}, len(rawHosts))
	hosts := make([]string, 0, len(rawHosts))
	for _, host := range rawHosts {
		if _, ok := seen[host]; ok {
			continue
		}
		seen[host] = struct{}{}
		hosts = append(hosts, host)
	}
	return hosts
}

func egressHostForEndpoint(endpoint string) []sandboxutil.Host {
	if _, ok := parseServiceEgressTarget(endpoint); ok {
		return []sandboxutil.Host{}
	}
	return dnsHostForEndpoint(endpoint)
}

func dnsHostForEndpoint(endpoint string) []sandboxutil.Host {
	host := endpointHost(endpoint)
	if host == "" {
		return []sandboxutil.Host{}
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		bits := 128
		if addr.Is4() {
			bits = 32
		}
		return []sandboxutil.Host{{
			Kind:  sandboxutil.HostKindCIDR,
			Value: netip.PrefixFrom(addr, bits).String(),
		}}
	}
	parsed, err := sandboxutil.ParseHost(host)
	if err != nil {
		return []sandboxutil.Host{}
	}
	return []sandboxutil.Host{parsed}
}

func endpointHost(endpoint string) string {
	parsed, ok := parseEndpointURL(endpoint)
	if !ok {
		return ""
	}
	host := parsed.Hostname()
	host = strings.Trim(host, "[]")
	if host == "" || host == "localhost" {
		return ""
	}
	return host
}

func parseEndpointURL(endpoint string) (*url.URL, bool) {
	raw := strings.TrimSpace(endpoint)
	if raw == "" {
		return nil, false
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, false
	}
	return parsed, true
}

type serviceEgressTarget struct {
	name      string
	namespace string
	port      string
}

func serviceEgressRules(endpoints ...string) []ciliumapi.EgressRule {
	seen := make(map[serviceEgressTarget]struct{}, len(endpoints))
	rules := make([]ciliumapi.EgressRule, 0, len(endpoints))
	for _, endpoint := range endpoints {
		target, ok := parseServiceEgressTarget(endpoint)
		if !ok {
			continue
		}
		if _, exists := seen[target]; exists {
			continue
		}
		seen[target] = struct{}{}
		rules = append(
			rules,
			ciliumapi.EgressRule{
				EgressCommonRule: ciliumapi.EgressCommonRule{
					ToServices: []ciliumapi.Service{{
						K8sService: &ciliumapi.K8sServiceNamespace{
							ServiceName: target.name,
							Namespace:   target.namespace,
						},
					}},
				},
				ToPorts: ciliumapi.PortRules{{
					Ports: []ciliumapi.PortProtocol{{
						Port:     target.port,
						Protocol: ciliumapi.ProtoTCP,
					}},
				}},
			},
		)
	}
	return rules
}

func parseServiceEgressTarget(endpoint string) (serviceEgressTarget, bool) {
	parsed, ok := parseEndpointURL(endpoint)
	if !ok {
		return serviceEgressTarget{}, false
	}

	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	parts := strings.Split(host, ".")
	if len(parts) != 5 {
		return serviceEgressTarget{}, false
	}
	if parts[2] != "svc" || parts[3] != "cluster" || parts[4] != "local" {
		return serviceEgressTarget{}, false
	}
	if parts[0] == "" || parts[1] == "" {
		return serviceEgressTarget{}, false
	}

	port := parsed.Port()
	if port == "" {
		switch strings.ToLower(parsed.Scheme) {
		case "https":
			port = "443"
		default:
			port = "80"
		}
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return serviceEgressTarget{}, false
	}

	return serviceEgressTarget{
		name:      parts[0],
		namespace: parts[1],
		port:      port,
	}, true
}
