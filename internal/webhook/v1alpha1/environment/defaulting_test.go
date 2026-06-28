package environment

import (
	"context"
	"strings"
	"testing"

	envcontroller "github.com/accuknox/clawarmor/internal/controller/environment"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

func TestDefaulterDefaultCanonicalizesHosts(t *testing.T) {
	t.Parallel()

	env := &clawarmorv1alpha1.Environment{
		Spec: clawarmorv1alpha1.EnvironmentSpec{
			AllowedHosts: []string{
				" GitHub.com ",
				"*.GitHub.com",
				"**.GitHub.com",
				"10.0.0.4/24",
				"github.com",
			},
		},
	}

	if err := NewDefaulter().Default(context.Background(), env); err != nil {
		t.Fatalf("Default() error = %v", err)
	}

	got := "[" + strings.Join(env.Spec.AllowedHosts, ",") + "]"
	want := "[github.com,*.github.com,**.github.com,10.0.0.0/24]"
	if got != want {
		t.Fatalf("AllowedHosts = %s, want %s", got, want)
	}

	if len(env.Spec.Packages) != len(envcontroller.DefaultPackages) {
		t.Fatalf("Packages length = %d, want %d", len(env.Spec.Packages), len(envcontroller.DefaultPackages))
	}
}
