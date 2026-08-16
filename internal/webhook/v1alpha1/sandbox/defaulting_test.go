package sandbox

import (
	"context"
	"strings"
	"testing"

	envcontroller "github.com/accuknox/agentz/internal/controller/sandbox"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestDefaulterDefaultParsesAndDeduplicatesHosts(t *testing.T) {
	t.Parallel()

	sandbox := &agentzv1alpha1.Sandbox{
		Spec: agentzv1alpha1.SandboxSpec{
			AllowedHosts: []string{
				" GitHub.com ",
				"*.GitHub.com",
				"**.GitHub.com",
				"10.0.0.4/24",
				"github.com",
			},
		},
	}

	if err := NewDefaulter().Default(context.Background(), sandbox); err != nil {
		t.Fatalf("Default() error = %v", err)
	}

	got := "[" + strings.Join(sandbox.Spec.AllowedHosts, ",") + "]"
	want := "[github.com,*.github.com,**.github.com,10.0.0.0/24]"
	if got != want {
		t.Fatalf("AllowedHosts = %s, want %s", got, want)
	}

	if len(sandbox.Spec.Packages) != len(envcontroller.DefaultPackages) {
		t.Fatalf("Packages length = %d, want %d", len(sandbox.Spec.Packages), len(envcontroller.DefaultPackages))
	}
}
