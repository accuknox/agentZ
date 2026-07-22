/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// MCPConnectionRef references one MCPConnection in the same namespace.
type MCPConnectionRef struct {
	// Name is the local name of the referenced MCPConnection.
	Name string `json:"name"`

	// Tools lists the upstream MCP tools exposed through this sandbox
	// for the referenced connection.
	Tools []SandboxMCPTool `json:"tools"`
}

// SandboxMCPTool describes one upstream MCP tool exposed through a
// sandbox.
type SandboxMCPTool struct {
	// Name is the upstream MCP tool name exposed through this sandbox.
	Name string `json:"name"`

	// RequireConsent asks the interactive user to approve this tool before
	// OpenCode runs it.
	RequireConsent bool `json:"requireConsent"`
}

// InferenceModelRef identifies one enabled model on one provider instance.
type InferenceModelRef struct {
	// Provider is the immutable InferenceProvider metadata name.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Provider string `json:"provider"`

	// Model is the exact upstream model identifier.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	Model string `json:"model"`
}

// SandboxInference defines the model policy inherited by referencing Agents.
// +kubebuilder:validation:XValidation:rule="self.models.exists(m, m.provider == self.defaultModel.provider && m.model == self.defaultModel.model)",message="default model must belong to the allowlist"
// +kubebuilder:validation:XValidation:rule="!has(self.smallModel) || self.models.exists(m, m.provider == self.smallModel.provider && m.model == self.smallModel.model)",message="small model must belong to the allowlist"
type SandboxInference struct {
	// Models is the hard provider/model allowlist.
	// +listType=map
	// +listMapKey=provider
	// +listMapKey=model
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=500
	Models []InferenceModelRef `json:"models"`

	// DefaultModel is the required primary OpenCode model.
	DefaultModel InferenceModelRef `json:"defaultModel"`

	// SmallModel is the optional OpenCode background-task model.
	// +optional
	SmallModel *InferenceModelRef `json:"smallModel,omitempty"`
}

// SandboxSpec defines the desired state of Sandbox.
type SandboxSpec struct {
	// Inference defines the model policy inherited by referencing Agents.
	Inference SandboxInference `json:"inference"`

	// Packages lists nix packages (e.g. "python3", "nodejs_22", "ripgrep") to
	// install into referencing Agent runtimes. Each entry is prefixed with
	// nixpkgs# automatically.
	// +optional
	Packages []string `json:"packages,omitempty"`

	// AllowedHosts lists exact domains, leading wildcard domains with "*."
	// or "**.", and IPv4/IPv6 CIDRs the referencing Agent pods may reach.
	// +optional
	AllowedHosts []string `json:"allowedHosts,omitempty"`

	// MCPConnectionRefs lists external MCP connections exposed in this
	// sandbox in order.
	// +optional
	MCPConnectionRefs []MCPConnectionRef `json:"mcpConnectionRefs,omitempty"`

	// Skills lists immutable Skill names exposed through this sandbox.
	// +optional
	// +listType=set
	// +kubebuilder:validation:MaxItems=200
	// +kubebuilder:validation:items:MaxLength=32
	// +kubebuilder:validation:items:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Skills []string `json:"skills,omitempty"`
}

// SandboxStatus defines the observed state of Sandbox.
type SandboxStatus struct {
	// ModelCount is the number of allowed inference models.
	// +optional
	ModelCount int `json:"modelCount,omitempty"`

	// InferenceReady reports whether referenced providers and models are ready.
	// +optional
	InferenceReady bool `json:"inferenceReady,omitempty"`

	// PackageCount is the number of nix packages configured.
	PackageCount int `json:"packageCount"`

	// AllowedHostCount is the number of allowed hosts configured.
	AllowedHostCount int `json:"allowedHostCount"`

	// MCPRefCount is the number of MCP connection references configured.
	MCPRefCount int `json:"mcpRefCount"`

	// conditions represent the current state of the Sandbox resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include:
	// - "Available": the resource is fully functional
	// - "Progressing": the resource is being created or updated
	// - "Degraded": the resource failed to reach or maintain its desired state
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +genclient
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:path=sandboxes
// +kubebuilder:printcolumn:name="Packages",type=integer,JSONPath=`.status.packageCount`,description="Number of nix packages"
// +kubebuilder:printcolumn:name="Allowed Hosts",type=integer,JSONPath=`.status.allowedHostCount`,description="Number of allowed hosts"
// +kubebuilder:printcolumn:name="MCPs",type=integer,JSONPath=`.status.mcpRefCount`,description="Number of MCP connection references"
// +kubebuilder:printcolumn:name="Models",type=integer,JSONPath=`.status.modelCount`,description="Number of allowed inference models"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Sandbox"

// Sandbox is the Schema for the sandboxes API.
type Sandbox struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Sandbox
	// +required
	Spec SandboxSpec `json:"spec"`

	// status defines the observed state of Sandbox
	// +optional
	Status SandboxStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// SandboxList contains a list of Sandbox.
type SandboxList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Sandbox `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Sandbox{}, &SandboxList{})
}
