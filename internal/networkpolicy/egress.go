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

// Package networkpolicy builds exact Cilium rules for controlled destinations.
package networkpolicy

import (
	"cmp"
	"errors"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"

	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
)

// Target is one admitted TCP destination.
type Target struct {
	Host string
	Port int32
}

// URLTarget resolves the exact TCP destination represented by an HTTP URL.
func URLTarget(raw string) (Target, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return Target{}, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return Target{}, errors.New("url scheme must be http or https")
	}
	if u.Hostname() == "" {
		return Target{}, errors.New("url has no hostname")
	}
	port := int32(443)
	if u.Scheme == "http" {
		port = 80
	}
	if u.Port() != "" {
		value, err := strconv.ParseInt(u.Port(), 10, 32)
		if err != nil {
			return Target{}, err
		}
		if value < 1 || value > 65535 {
			return Target{}, errors.New("url port must be between 1 and 65535")
		}
		port = int32(value)
	}
	return Target{Host: u.Hostname(), Port: port}, nil
}

// ServiceEgress permits DNS resolution and one Kubernetes Service TCP port.
func ServiceEgress(namespace, name string, port int32) []ciliumapi.EgressRule {
	service := ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToServices: []ciliumapi.Service{{
				K8sService: &ciliumapi.K8sServiceNamespace{
					ServiceName: name,
					Namespace:   namespace,
				},
			}},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{{
				Port:     strconv.FormatInt(int64(port), 10),
				Protocol: ciliumapi.ProtoTCP,
			}},
		}},
	}
	dns := ciliumapi.EgressRule{
		EgressCommonRule: ciliumapi.EgressCommonRule{
			ToEndpoints: []ciliumapi.EndpointSelector{dnsEndpointSelector()},
		},
		ToPorts: ciliumapi.PortRules{{
			Ports: dnsPorts(),
			Rules: &ciliumapi.L7Rules{DNS: ciliumapi.PortRulesDNS{{
				MatchName: name + "." + namespace + ".svc.cluster.local",
			}}},
		}},
	}
	return []ciliumapi.EgressRule{service, dns}
}

// ExternalEgress permits only the supplied FQDN or IP destinations and their ports.
func ExternalEgress(targets []Target) []ciliumapi.EgressRule {
	slices.SortFunc(
		targets,
		func(a, b Target) int {
			if a.Host == b.Host {
				return cmp.Compare(a.Port, b.Port)
			}
			return strings.Compare(a.Host, b.Host)
		},
	)
	targets = slices.Compact(targets)
	rules := make([]ciliumapi.EgressRule, 0, len(targets)+1)
	dns := ciliumapi.PortRulesDNS{}
	for _, target := range targets {
		port := ciliumapi.PortRules{{
			Ports: []ciliumapi.PortProtocol{{
				Port:     strconv.FormatInt(int64(target.Port), 10),
				Protocol: ciliumapi.ProtoTCP,
			}},
		}}
		addr, err := netip.ParseAddr(target.Host)
		if err == nil {
			rules = append(
				rules,
				ciliumapi.EgressRule{
					EgressCommonRule: ciliumapi.EgressCommonRule{
						ToCIDRSet: ciliumapi.CIDRRuleSlice{{
							Cidr: ciliumapi.CIDR(netip.PrefixFrom(addr, addr.BitLen()).String()),
						}},
					},
					ToPorts: port,
				},
			)
			continue
		}
		rules = append(
			rules,
			ciliumapi.EgressRule{
				ToFQDNs: ciliumapi.FQDNSelectorSlice{{MatchName: target.Host}},
				ToPorts: port,
			},
		)
		dns = append(dns, ciliumapi.PortRuleDNS{MatchName: target.Host})
	}
	if len(dns) == 0 {
		return rules
	}
	return append(
		rules,
		ciliumapi.EgressRule{
			EgressCommonRule: ciliumapi.EgressCommonRule{
				ToEndpoints: []ciliumapi.EndpointSelector{dnsEndpointSelector()},
			},
			ToPorts: ciliumapi.PortRules{{
				Ports: dnsPorts(),
				Rules: &ciliumapi.L7Rules{DNS: dns},
			}},
		},
	)
}

func dnsEndpointSelector() ciliumapi.EndpointSelector {
	return ciliumapi.EndpointSelector{
		LabelSelector: &slimv1.LabelSelector{MatchLabels: map[string]string{
			"k8s:io.kubernetes.pod.namespace": "kube-system",
			"k8s:k8s-app":                     "kube-dns",
		}},
	}
}

func dnsPorts() []ciliumapi.PortProtocol {
	return []ciliumapi.PortProtocol{
		{Port: "53", Protocol: ciliumapi.ProtoUDP},
		{Port: "53", Protocol: ciliumapi.ProtoTCP},
	}
}
