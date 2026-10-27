package inference

import (
	"fmt"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestSandboxTargetCallerRoutes(t *testing.T) {
	// The same agent name can exist in multiple workspaces while both use an
	// organization-owned Sandbox. Each match must retain the full identity.
	agents := make([]api.Agent, 65)
	for i := range agents {
		agents[i].ObjectMeta = metav1.ObjectMeta{
			Namespace: fmt.Sprintf("workspace-%d", i),
			Name:      "billy",
		}
	}
	target := SandboxTarget{
		Name:    "provider",
		Backend: "provider",
		Path:    SandboxProviderPath("shared", "provider"),
		Models:  []string{"model"},
		ExtAuth: true,
	}
	runtime := RenderSandboxTarget("organization", "shared", target, agents)
	if len(runtime.Route.Spec.Rules) != 2 {
		t.Fatalf("route did not split agent matches at the rule limit: %d", len(runtime.Route.Spec.Rules))
	}
	count := 0
	for _, rule := range runtime.Route.Spec.Rules {
		if len(rule.Matches) == 0 || len(rule.Matches) > 64 || len(rule.Filters) != 1 {
			t.Fatal("caller matching lost route limits or authorization context")
		}
		for _, match := range rule.Matches {
			path := *match.Path.Value
			parts := strings.Split(path, "/")
			if parts[2] != agents[count].Namespace || parts[3] != "billy" || parts[5] != "shared" || parts[7] != "provider" {
				t.Fatalf("caller or resource identity was lost: %s", path)
			}
			count++
		}
	}
	if count != len(agents) {
		t.Fatalf("lost caller matches: %d of %d", count, len(agents))
	}
}
