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
	"slices"
	"strings"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumlabels "github.com/cilium/cilium/pkg/labels"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/accuknox/clawarmor/internal/envutil"
	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

var packageInstallPolicyHosts = []envutil.Host{
	{Kind: envutil.HostKindWildcard, Value: "*.nixos.org"},
	{Kind: envutil.HostKindDomain, Value: "github.com"},
	{Kind: envutil.HostKindWildcard, Value: "*.github.com"},
}

func (r *Reconciler) reconcileEgressPolicy(ctx context.Context, agt *clawarmorv1alpha1.Agent, envCfg environmentConfig) error {
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
	_, err = ctrlutil.CreateOrPatch(ctx, r.Client, current, func() error {
		current.Labels = resourceLabels(agt)
		current.Annotations = agt.Annotations
		current.Spec = spec
		return ctrl.SetControllerReference(agt, current, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("create or patch egress policy: %w", err)
	}
	return nil
}

func (r *Reconciler) buildEgressPolicySpec(agt *clawarmorv1alpha1.Agent, envCfg environmentConfig) (*ciliumapi.Rule, error) {
	hosts, err := r.resolveDirectEgressHosts(agt, envCfg)
	if err != nil {
		return nil, err
	}
	egress := buildHostEgressRules(hosts, r.sinjectorEnabled())
	if envCfg.MCPURL != "" {
		egress = append(egress, gatewayMcpEgressRule(agt.Namespace))
	}

	if r.sinjectorEnabled() {
		egress = append(egress, sinjectorEgressRule(agt))
	}

	return &ciliumapi.Rule{
		EndpointSelector: ciliumapi.NewESFromLabels(
			ciliumlabels.NewLabel(
				"clawarmor.accuknox.com/agent",
				agt.Name,
				ciliumlabels.LabelSourceK8s,
			),
		),
		Egress: egress,
	}, nil
}

func (r *Reconciler) resolveDirectEgressHosts(agt *clawarmorv1alpha1.Agent, envCfg environmentConfig) ([]envutil.Host, error) {
	hosts, err := envutil.ParseHostList(envCfg.AllowedHosts)
	if err != nil {
		return nil, err
	}

	hosts = append(hosts, r.automaticEgressHosts(agt)...)
	hosts = uniqueHosts(hosts)
	if !r.sinjectorEnabled() {
		return hosts, nil
	}

	noProxy := r.agentNoProxyHosts(agt)
	var direct []envutil.Host

	for _, host := range hosts {
		if hostMatchesNoProxy(host, noProxy) ||
			slices.Contains(packageInstallPolicyHosts, host) {
			direct = append(direct, host)
		}
	}

	return direct, nil
}

func buildHostEgressRules(hosts []envutil.Host, includeDNS bool) []ciliumapi.EgressRule {
	fqdns := ciliumapi.FQDNSelectorSlice{}
	cidrs := ciliumapi.CIDRRuleSlice{}
	for _, host := range hosts {
		switch host.Kind {
		case envutil.HostKindDomain:
			fqdns = append(fqdns, ciliumapi.FQDNSelector{MatchName: host.Value})
		case envutil.HostKindWildcard:
			fqdns = append(fqdns, ciliumapi.FQDNSelector{MatchPattern: host.Value})
		case envutil.HostKindCIDR:
			cidrs = append(cidrs, ciliumapi.CIDRRule{Cidr: ciliumapi.CIDR(host.Value)})
		}
	}

	egress := []ciliumapi.EgressRule{}
	if includeDNS {
		egress = append(egress, dnsEgressRule())
	}
	if len(fqdns) > 0 {
		egress = append(egress, ciliumapi.EgressRule{ToFQDNs: fqdns})
	}
	if len(cidrs) > 0 {
		egress = append(egress, ciliumapi.EgressRule{
			EgressCommonRule: ciliumapi.EgressCommonRule{ToCIDRSet: cidrs},
		})
	}
	return egress
}

func hostMatchesNoProxy(host envutil.Host, noProxy []string) bool {
	switch host.Kind {
	case envutil.HostKindDomain, envutil.HostKindWildcard:
		name := host.Value
		if host.Kind == envutil.HostKindWildcard {
			name = strings.TrimPrefix(name, "*.")
		}
		for _, item := range noProxy {
			item = strings.ToLower(strings.TrimSpace(item))
			if item == "" {
				continue
			}
			if after, ok := strings.CutPrefix(item, "."); ok {
				if name == after || strings.HasSuffix(name, item) {
					return true
				}
				continue
			}
			if name == item {
				return true
			}
		}
	case envutil.HostKindCIDR:
		prefix, err := netip.ParsePrefix(host.Value)
		if err != nil {
			return false
		}
		for _, item := range noProxy {
			item = strings.ToLower(strings.TrimSpace(item))
			if item == "" {
				continue
			}
			addr, err := netip.ParseAddr(item)
			if err == nil {
				if prefix.Bits() == addr.BitLen() && prefix.Addr() == addr {
					return true
				}
				continue
			}
			other, err := netip.ParsePrefix(item)
			if err == nil && prefix == other.Masked() {
				return true
			}
		}
	}
	return false
}

func uniqueHosts(hosts []envutil.Host) []envutil.Host {
	seen := make(map[envutil.Host]struct{}, len(hosts))
	out := make([]envutil.Host, 0, len(hosts))
	for _, host := range hosts {
		if _, ok := seen[host]; ok {
			continue
		}
		seen[host] = struct{}{}
		out = append(out, host)
	}
	return out
}

func dnsEgressRule() ciliumapi.EgressRule {
	return ciliumapi.EgressRule{
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
				DNS: ciliumapi.PortRulesDNS{
					{MatchPattern: "*"},
				},
			},
		}},
	}
}

func gatewayMcpEgressRule(namespace string) ciliumapi.EgressRule {
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
						mcp.GatewayName,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"app.kubernetes.io/instance",
						mcp.GatewayName,
						ciliumlabels.LabelSourceK8s,
					),
					ciliumlabels.NewLabel(
						"gateway.networking.k8s.io/gateway-name",
						mcp.GatewayName,
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

func sinjectorEgressRule(agt *clawarmorv1alpha1.Agent) ciliumapi.EgressRule {
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
						"clawarmor.accuknox.com/sinjector",
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

func (r *Reconciler) agentNoProxyHosts(agt *clawarmorv1alpha1.Agent) []string {
	hosts := []string{
		"127.0.0.1",
		"::1",
		"localhost",
		".cluster.local",
		".svc",
	}
	gatewayHost := endpointHost(r.Config.GatewayURL)
	if gatewayHost != "" {
		hosts = append(hosts, gatewayHost)
	}
	if agt.Spec.Telemetry.Enabled {
		host := endpointHost(agt.Spec.Telemetry.TraceEndpoint)
		if host != "" {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

func (r *Reconciler) automaticEgressHosts(agt *clawarmorv1alpha1.Agent) []envutil.Host {
	var hosts []envutil.Host
	if agt.Spec.Telemetry.Enabled {
		hosts = append(hosts, hostForEndpoint(agt.Spec.Telemetry.TraceEndpoint)...)
	}
	hosts = append(hosts, hostForEndpoint(r.Config.GatewayURL)...)
	// TODO: move away from init-container to an init Job
	hosts = append(hosts, packageInstallPolicyHosts...)
	return hosts
}

func hostForEndpoint(endpoint string) []envutil.Host {
	host := endpointHost(endpoint)
	if host == "" {
		return []envutil.Host{}
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		bits := 128
		if addr.Is4() {
			bits = 32
		}
		return []envutil.Host{{
			Kind:  envutil.HostKindCIDR,
			Value: netip.PrefixFrom(addr, bits).String(),
		}}
	}
	parsed, err := envutil.ParseHost(host)
	if err != nil {
		return []envutil.Host{}
	}
	return []envutil.Host{parsed}
}

func endpointHost(endpoint string) string {
	raw := strings.TrimSpace(endpoint)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := parsed.Hostname()
	host = strings.Trim(host, "[]")
	if host == "" || host == "localhost" {
		return ""
	}
	return host
}
