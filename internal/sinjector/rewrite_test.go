package sinjector

import (
	"context"
	"errors"
	"testing"
)

type testResolver struct {
	values map[string]string
	hosts  map[string][]string
	calls  map[string]int
}

func (r *testResolver) resolve(_ context.Context, name string) (resolvedSecret, error) {
	r.calls[name]++
	value, ok := r.values[name]
	if !ok {
		return resolvedSecret{}, errors.New("not found")
	}
	hosts := r.hosts[name]
	if len(hosts) == 0 {
		hosts = []string{"example.com"}
	}
	return resolvedSecret{value: value, hosts: hosts}, nil
}

func TestReplacePlaceholders(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"OPENAI_API_KEY": "sk-test"},
		calls:  map[string]int{},
	}
	got, changed := replacePlaceholders(
		context.Background(),
		"Bearer agentz:resolve:env:OPENAI_API_KEY",
		res,
		"example.com:443",
	)
	if !changed {
		t.Fatal("changed = false, want true")
	}
	if got != "Bearer sk-test" {
		t.Fatalf("got %q, want %q", got, "Bearer sk-test")
	}
	if res.calls["OPENAI_API_KEY"] != 1 {
		t.Fatalf("openbao calls = %d, want 1", res.calls["OPENAI_API_KEY"])
	}
}

func TestReplacePlaceholdersLeavesInvalidNameUnchanged(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"TOKEN-NAME": "secret"},
		calls:  map[string]int{},
	}
	got, changed := replacePlaceholders(
		context.Background(),
		"Bearer agentz:resolve:env:TOKEN-NAME",
		res,
		"example.com:443",
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "Bearer agentz:resolve:env:TOKEN-NAME" {
		t.Fatalf("got %q, want unchanged text", got)
	}
	if res.calls["TOKEN"] != 0 {
		t.Fatalf("openbao calls = %d, want 0", res.calls["TOKEN"])
	}
}

func TestReplacePlaceholdersLeavesDangerousSecretUnchanged(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"TOKEN": "secret\r\nX-Evil: yes"},
		calls:  map[string]int{},
	}
	got, changed := replacePlaceholders(
		context.Background(),
		"Bearer agentz:resolve:env:TOKEN",
		res,
		"example.com:443",
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "Bearer agentz:resolve:env:TOKEN" {
		t.Fatalf("got %q, want unchanged text", got)
	}
}

func TestReplacePath(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"TOKEN": "abc 123"},
		calls:  map[string]int{},
	}
	got, changed := replacePath(
		context.Background(),
		"/bot/agentz:resolve:env:TOKEN/sendMessage",
		res,
		"example.com:443",
	)
	if !changed {
		t.Fatal("changed = false, want true")
	}
	if got != "/bot/abc 123/sendMessage" {
		t.Fatalf("got %q, want path with secret", got)
	}
}

func TestReplacePathLeavesTraversalSecretUnchanged(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"TOKEN": "../secret"},
		calls:  map[string]int{},
	}
	got, changed := replacePath(
		context.Background(),
		"/bot/agentz:resolve:env:TOKEN/sendMessage",
		res,
		"example.com:443",
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "/bot/agentz:resolve:env:TOKEN/sendMessage" {
		t.Fatalf("got %q, want unchanged path", got)
	}
}

func TestReplacePlaceholdersLeavesMismatchedHostUnchanged(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"TOKEN": "secret"},
		hosts:  map[string][]string{"TOKEN": {"api.example.com"}},
		calls:  map[string]int{},
	}
	got, changed := replacePlaceholders(
		context.Background(),
		"Bearer agentz:resolve:env:TOKEN",
		res,
		"other.example.com:443",
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "Bearer agentz:resolve:env:TOKEN" {
		t.Fatalf("got %q, want unchanged text", got)
	}
}

func TestSecretHostMatchesWildcardDepth(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		target   string
		hosts    []string
		expected bool
	}{
		{
			name:     "single wildcard matches one label",
			target:   "foo.example.com:443",
			hosts:    []string{"*.example.com"},
			expected: true,
		},
		{
			name:     "single wildcard rejects deep subdomain",
			target:   "bar.foo.example.com:443",
			hosts:    []string{"*.example.com"},
			expected: false,
		},
		{
			name:     "deep wildcard matches one label",
			target:   "foo.example.com:443",
			hosts:    []string{"**.example.com"},
			expected: true,
		},
		{
			name:     "deep wildcard matches deep subdomain",
			target:   "bar.foo.example.com:443",
			hosts:    []string{"**.example.com"},
			expected: true,
		},
		{
			name:     "wildcards reject apex",
			target:   "example.com:443",
			hosts:    []string{"*.example.com", "**.example.com"},
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := SecretHostMatches(tc.target, tc.hosts)
			if got != tc.expected {
				t.Fatalf("SecretHostMatches(%q, %v) = %v, want %v", tc.target, tc.hosts, got, tc.expected)
			}
		})
	}
}
