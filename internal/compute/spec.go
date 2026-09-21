// Package compute defines the native Agent runtime transport contract.
package compute

import (
	"encoding/json"

	"github.com/accuknox/agentz/internal/skill"
)

// NativeEndpoints identifies the daemon-owned bridges and runtime directories.
// Backend credentials never appear in these local endpoint addresses.
type NativeEndpoints struct {
	MCP                      string
	Inference                string
	Platform                 string
	Proxy                    string
	ConfigDirectory          string
	BundledSkillsDirectory   string
	ImmutableSkillsDirectory string
	WritableSkillsDirectory  string
	CABundlePath             string
	GatewayTokenPath         string
	WorkDirectory            string
}

// RuntimeSpec is the resolved configuration of one native Agent execution.
// It shares the Kubernetes runtime's renderer, policies and skill references.
type RuntimeSpec struct {
	CABundle       []byte                `json:"caBundle,omitempty"`
	OpenCodeConfig []byte                `json:"openCodeConfig"`
	Instructions   map[string]string     `json:"instructions"`
	Packages       []string              `json:"packages"`
	AllowedHosts   []string              `json:"allowedHosts"`
	Skills         []skill.ManifestSkill `json:"skills"`
	Env            map[string]string     `json:"env"`
	SecretProxy    bool                  `json:"secretProxy"`
	WorkDirectory  string                `json:"workDirectory"`
}

// SecurityEvent carries a native KubeArmor record; tenancy comes from authenticated assignment.
type SecurityEvent struct {
	Kind  string          `json:"kind"`
	Event json.RawMessage `json:"event"`
}
