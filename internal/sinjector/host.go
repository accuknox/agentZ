package sinjector

import (
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

const maxSecretHosts = 100

type hostKind int

const (
	hostDomain hostKind = iota
	hostWildcardDomain
	hostDeepWildcardDomain
	hostIP
	hostCIDR
)

type secretHost struct {
	raw    string
	kind   hostKind
	domain string
	addr   netip.Addr
	prefix netip.Prefix
}

type requestTarget struct {
	raw    string
	domain string
	addr   netip.Addr
}

// ParseSecretHosts validates secret hosts and returns stable values.
func ParseSecretHosts(hosts []string) ([]string, error) {
	if len(hosts) == 0 {
		return nil, fmt.Errorf("at least one host is required")
	}
	if len(hosts) > maxSecretHosts {
		return nil, fmt.Errorf("must contain at most %d hosts", maxSecretHosts)
	}

	out := make([]string, 0, len(hosts))
	seen := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		parsed, err := parseSecretHost(host)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[parsed.raw]; ok {
			continue
		}
		seen[parsed.raw] = struct{}{}
		out = append(out, parsed.raw)
	}

	slices.Sort(out)
	return out, nil
}

// SecretHostMatches reports whether a CONNECT destination matches any
// canonical secret host.
func SecretHostMatches(connectHost string, hosts []string) bool {
	req, err := parseRequestTarget(connectHost)
	if err != nil {
		return false
	}
	for _, host := range hosts {
		parsed, err := parseSecretHost(host)
		if err != nil {
			continue
		}
		if parsed.matches(req) {
			return true
		}
	}
	return false
}

func parseRequestTarget(host string) (requestTarget, error) {
	host = stripPort(strings.TrimSpace(host))
	host = strings.Trim(host, "[]")
	if host == "" {
		return requestTarget{}, fmt.Errorf("host is required")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return requestTarget{raw: addr.String(), addr: addr}, nil
	}
	host = strings.ToLower(host)
	if err := validateHostname(host); err != nil {
		return requestTarget{}, err
	}
	domain := strings.TrimSuffix(host, ".")
	return requestTarget{raw: domain, domain: domain}, nil
}

func parseSecretHost(target string) (secretHost, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return secretHost{}, fmt.Errorf("host is required")
	}

	if prefix, err := netip.ParsePrefix(target); err == nil {
		prefix = prefix.Masked()
		return secretHost{
			raw:    prefix.String(),
			kind:   hostCIDR,
			prefix: prefix,
		}, nil
	}

	if addr, err := netip.ParseAddr(strings.Trim(target, "[]")); err == nil {
		return secretHost{
			raw:  addr.String(),
			kind: hostIP,
			addr: addr,
		}, nil
	}

	if suffix, ok := strings.CutPrefix(target, "**."); ok {
		suffix = strings.ToLower(suffix)
		if err := validateHostname(suffix); err != nil {
			return secretHost{}, fmt.Errorf("invalid wildcard host %q: %w", target, err)
		}
		domain := strings.TrimSuffix(suffix, ".")
		return secretHost{
			raw:    "**." + domain,
			kind:   hostDeepWildcardDomain,
			domain: domain,
		}, nil
	}

	if suffix, ok := strings.CutPrefix(target, "*."); ok {
		suffix = strings.ToLower(suffix)
		if err := validateHostname(suffix); err != nil {
			return secretHost{}, fmt.Errorf("invalid wildcard host %q: %w", target, err)
		}
		domain := strings.TrimSuffix(suffix, ".")
		return secretHost{
			raw:    "*." + domain,
			kind:   hostWildcardDomain,
			domain: domain,
		}, nil
	}

	target = strings.ToLower(target)
	if err := validateHostname(target); err != nil {
		return secretHost{}, fmt.Errorf("invalid host %q: %w", target, err)
	}
	domain := strings.TrimSuffix(target, ".")
	return secretHost{
		raw:    domain,
		kind:   hostDomain,
		domain: domain,
	}, nil
}

func (t secretHost) matches(req requestTarget) bool {
	switch t.kind {
	case hostDomain:
		return req.domain == t.domain
	case hostWildcardDomain:
		if req.domain == t.domain || !strings.HasSuffix(req.domain, "."+t.domain) {
			return false
		}
		prefix := strings.TrimSuffix(req.domain, "."+t.domain)
		return !strings.Contains(prefix, ".")
	case hostDeepWildcardDomain:
		return req.domain != t.domain && strings.HasSuffix(req.domain, "."+t.domain)
	case hostIP:
		return req.addr.IsValid() && req.addr == t.addr
	case hostCIDR:
		return req.addr.IsValid() && t.prefix.Contains(req.addr)
	default:
		return false
	}
}

func validateHostname(host string) error {
	host = strings.TrimSuffix(strings.TrimSpace(host), ".")
	if host == "" {
		return fmt.Errorf("hostname is required")
	}
	if net.ParseIP(host) != nil {
		return fmt.Errorf("IP hosts must be valid IP literals")
	}
	if errs := validation.IsDNS1123Subdomain(host); len(errs) > 0 {
		return fmt.Errorf("hostname is invalid: %s", strings.Join(errs, "; "))
	}
	return nil
}
