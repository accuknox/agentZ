package sandboxutil

import (
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

// HostKind identifies a canonical sandbox host entry.
type HostKind string

const (
	// HostKindCIDR identifies an IPv4 or IPv6 CIDR entry.
	HostKindCIDR HostKind = "cidr"
	// HostKindDomain identifies an exact DNS name entry.
	HostKindDomain HostKind = "domain"
	// HostKindWildcard identifies a single-label DNS wildcard entry.
	HostKindWildcard HostKind = "wildcard"
	// HostKindDeepWildcard identifies a multi-label DNS wildcard entry.
	HostKindDeepWildcard HostKind = "deep_wildcard"
)

var errEmptyHost = errors.New("must not be empty")

// Host is a canonical sandbox egress destination.
type Host struct {
	// Kind is the parsed host category used for policy generation.
	Kind HostKind
	// Value is the canonical host value.
	Value string
}

// Allows reports whether an allowed-host entry includes the exact destination
// host. It is used at admission to prevent provider endpoints from bypassing
// the inference gateway through a broader sandbox egress rule.
func (h Host) Allows(target string) bool {
	target = strings.TrimSuffix(strings.ToLower(target), ".")
	if h.Kind == HostKindCIDR {
		prefix, err := netip.ParsePrefix(h.Value)
		if err != nil {
			return false
		}
		addr, err := netip.ParseAddr(target)
		return err == nil && prefix.Contains(addr)
	}
	if h.Kind == HostKindDomain {
		return target == h.Value
	}
	base := strings.TrimPrefix(h.Value, "*.")
	if h.Kind == HostKindDeepWildcard {
		base = strings.TrimPrefix(h.Value, "**.")
		return target == base || strings.HasSuffix(target, "."+base)
	}
	prefix, matches := strings.CutSuffix(target, "."+base)
	return matches && prefix != "" && !strings.Contains(prefix, ".")
}

// ParseHost validates one sandbox host entry and returns its canonical form.
func ParseHost(raw string) (Host, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return Host{}, errEmptyHost
	}

	if strings.Contains(value, "/") {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return Host{}, errors.New("must be a valid ipv4 or ipv6 cidr")
		}
		return Host{Kind: HostKindCIDR, Value: prefix.Masked().String()}, nil
	}

	if _, err := netip.ParseAddr(value); err == nil {
		return Host{}, errors.New("must include a cidr prefix length")
	}

	value = strings.ToLower(value)
	if after, ok := strings.CutPrefix(value, "**."); ok {
		if err := validateDomain(after); err != nil {
			return Host{}, err
		}
		return Host{Kind: HostKindDeepWildcard, Value: "**." + after}, nil
	}
	if after, ok := strings.CutPrefix(value, "*."); ok {
		domain := after
		if err := validateDomain(domain); err != nil {
			return Host{}, err
		}
		return Host{Kind: HostKindWildcard, Value: "*." + domain}, nil
	}
	if strings.Contains(value, "*") {
		return Host{}, errors.New("wildcards must use leading *.|**. form")
	}
	if err := validateDomain(value); err != nil {
		return Host{}, err
	}
	return Host{Kind: HostKindDomain, Value: value}, nil
}

func validateDomain(value string) error {
	errs := validation.IsDNS1123Subdomain(value)
	if len(errs) == 0 {
		return nil
	}
	return errors.New("must be a valid dns domain")
}

// ParseHostList validates canonical host entries and groups them by kind.
func ParseHostList(raw []string) ([]Host, error) {
	hosts := make([]Host, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for i, entry := range raw {
		host, err := ParseHost(entry)
		if err != nil {
			return nil, fmt.Errorf("allowedHosts[%d]: %w", i, err)
		}
		if _, ok := seen[host.Value]; ok {
			continue
		}
		seen[host.Value] = struct{}{}
		hosts = append(hosts, host)
	}
	slices.SortFunc(hosts, func(a, b Host) int {
		return strings.Compare(a.Value, b.Value)
	})
	return hosts, nil
}
