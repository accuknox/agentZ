package envhost

import (
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

// Kind identifies a normalized environment host entry.
type Kind string

const (
	// KindCIDR identifies an IPv4 or IPv6 CIDR entry.
	KindCIDR Kind = "cidr"
	// KindDomain identifies an exact DNS name entry.
	KindDomain Kind = "domain"
	// KindWildcard identifies a leading-star DNS wildcard entry.
	KindWildcard Kind = "wildcard"
)

var errEmptyHost = errors.New("must not be empty")

// Host is a normalized environment egress destination.
type Host struct {
	// Kind is the parsed host category used for policy generation.
	Kind Kind
	// Value is the normalized host value.
	Value string
}

// NormalizeList trims, validates, lowercases, and de-duplicates host entries.
func NormalizeList(raw []string) ([]string, error) {
	hosts := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for i, entry := range raw {
		host, err := Parse(entry)
		if err != nil {
			return nil, fmt.Errorf("allowedHosts[%d]: %w", i, err)
		}
		if _, ok := seen[host.Value]; ok {
			continue
		}
		seen[host.Value] = struct{}{}
		hosts = append(hosts, host.Value)
	}
	return hosts, nil
}

// Parse validates and normalizes one environment host entry.
func Parse(raw string) (Host, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return Host{}, errEmptyHost
	}

	if strings.Contains(value, "/") {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return Host{}, errors.New("must be a valid ipv4 or ipv6 cidr")
		}
		return Host{Kind: KindCIDR, Value: prefix.Masked().String()}, nil
	}

	if _, err := netip.ParseAddr(value); err == nil {
		return Host{}, errors.New("must include a cidr prefix length")
	}

	value = strings.ToLower(value)
	if strings.HasPrefix(value, "*.") {
		domain := strings.TrimPrefix(value, "*.")
		if err := validateDomain(domain); err != nil {
			return Host{}, err
		}
		return Host{Kind: KindWildcard, Value: "*." + domain}, nil
	}
	if strings.Contains(value, "*") {
		return Host{}, errors.New("wildcards must use leading-star form")
	}
	if err := validateDomain(value); err != nil {
		return Host{}, err
	}
	return Host{Kind: KindDomain, Value: value}, nil
}

func validateDomain(value string) error {
	errs := validation.IsDNS1123Subdomain(value)
	if len(errs) == 0 {
		return nil
	}
	return errors.New("must be a valid dns domain")
}

// ParseList validates normalized host entries and groups them by kind.
func ParseList(raw []string) ([]Host, error) {
	hosts := make([]Host, 0, len(raw))
	for i, entry := range raw {
		host, err := Parse(entry)
		if err != nil {
			return nil, fmt.Errorf("allowedHosts[%d]: %w", i, err)
		}
		hosts = append(hosts, host)
	}
	slices.SortFunc(hosts, func(a, b Host) int {
		return strings.Compare(a.Value, b.Value)
	})
	return hosts, nil
}
