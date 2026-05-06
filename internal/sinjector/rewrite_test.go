package sinjector

import (
	"context"
	"errors"
	"testing"
)

type testResolver struct {
	values map[string]string
	calls  map[string]int
}

func (r *testResolver) resolve(_ context.Context, name string) (string, error) {
	r.calls[name]++
	value, ok := r.values[name]
	if !ok {
		return "", errors.New("not found")
	}
	return value, nil
}

func TestReplacePlaceholders(t *testing.T) {
	res := &testResolver{
		values: map[string]string{"OPENAI_API_KEY": "sk-test"},
		calls:  map[string]int{},
	}
	got, changed := replacePlaceholders(
		context.Background(),
		"Bearer clawarmor:resolve:env:OPENAI_API_KEY",
		res,
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
		"Bearer clawarmor:resolve:env:TOKEN-NAME",
		res,
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "Bearer clawarmor:resolve:env:TOKEN-NAME" {
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
		"Bearer clawarmor:resolve:env:TOKEN",
		res,
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "Bearer clawarmor:resolve:env:TOKEN" {
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
		"/bot/clawarmor:resolve:env:TOKEN/sendMessage",
		res,
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
		"/bot/clawarmor:resolve:env:TOKEN/sendMessage",
		res,
	)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != "/bot/clawarmor:resolve:env:TOKEN/sendMessage" {
		t.Fatalf("got %q, want unchanged path", got)
	}
}
