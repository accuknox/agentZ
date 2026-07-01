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

// SandboxMCPTool describes one upstream MCP tool exposed through an
// sandbox.
type SandboxMCPTool struct {
	// Name is the upstream MCP tool name exposed through this sandbox.
	Name string `json:"name"`

	// RequireConsent asks the interactive user to approve this tool before
	// OpenCode runs it.
	RequireConsent bool `json:"requireConsent"`
}

// SandboxSpec defines the desired state of Sandbox.
type SandboxSpec struct {
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
}

// SandboxStatus defines the observed state of Sandbox.
type SandboxStatus struct {
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
