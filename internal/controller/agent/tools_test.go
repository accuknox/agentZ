package agent

import (
	"encoding/json"
	"testing"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// TestToolPermissions keeps trusted scripts executable while protecting Plan mode.
func TestToolPermissions(t *testing.T) {
	t.Parallel()
	agt := &agentzv1alpha1.Agent{Spec: agentzv1alpha1.AgentSpec{
		Tools: []agentzv1alpha1.AgentTool{{Name: "trusted_script"}},
	}}
	for _, kind := range []agentzv1alpha1.WorkspaceType{agentzv1alpha1.WorkspaceTypeGeneral, agentzv1alpha1.WorkspaceTypeCoding} {
		t.Run(string(kind), func(t *testing.T) {
			raw, _, err := renderOpencodeConfig(agt, sandboxConfig{WorkspaceType: kind})
			if err != nil {
				t.Fatal(err)
			}
			var cfg opencodeConfigFile
			if err := json.Unmarshal(raw, &cfg); err != nil {
				t.Fatal(err)
			}
			if cfg.Agent["plan"].Permission["trusted_script"]["*"] != "deny" {
				t.Fatal("Plan allows uploaded source to execute")
			}
			for _, name := range []string{"build", "general"} {
				if cfg.Agent[name].Permission["trusted_script"] != nil {
					t.Fatalf("Plan's restriction leaked into %s", name)
				}
			}
		})
	}
}

// TestToolSourceTriggersRollout prevents script replacements from reusing a cached runtime.
func TestToolSourceTriggersRollout(t *testing.T) {
	t.Parallel()
	tools := []agentzv1alpha1.AgentTool{{Name: "trusted_script", Script: "echo before"}}
	before, err := configHash(nil, nil, nil, sandboxConfig{}, tools)
	if err != nil {
		t.Fatal(err)
	}
	tools[0].Script = "echo after"
	after, err := configHash(nil, nil, nil, sandboxConfig{}, tools)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("replacing tool source did not change the rollout hash")
	}
}
