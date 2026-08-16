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

import (
	"slices"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// WorkspaceConditionReady indicates the Workspace namespace is ready.
	WorkspaceConditionReady = "Ready"
	// WorkspaceConditionProgressing indicates Workspace provisioning is active.
	WorkspaceConditionProgressing = "Progressing"
	// WorkspaceConditionDegraded indicates Workspace provisioning failed.
	WorkspaceConditionDegraded = "Degraded"
)

const (
	// WorkspaceReasonProvisioning indicates namespace provisioning is active.
	WorkspaceReasonProvisioning = "Provisioning"
	// WorkspaceReasonInfrastructureReady indicates all Workspace infrastructure is ready.
	WorkspaceReasonInfrastructureReady = "InfrastructureReady"
	// WorkspaceReasonIdentityInvalid indicates immutable Workspace identity is invalid.
	WorkspaceReasonIdentityInvalid = "IdentityInvalid"
	// WorkspaceReasonTenantUnavailable indicates Organisation infrastructure is unavailable.
	WorkspaceReasonTenantUnavailable = "TenantUnavailable"
	// WorkspaceReasonNamespaceConflict indicates the stable namespace belongs to another owner.
	WorkspaceReasonNamespaceConflict = "NamespaceConflict"
	// WorkspaceReasonStoragePending indicates shared package storage is not ready.
	WorkspaceReasonStoragePending = "StoragePending"
	// WorkspaceReasonStorageInvalid indicates shared package storage cannot be safely adopted.
	WorkspaceReasonStorageInvalid = "StorageInvalid"
	// WorkspaceReasonNetworkPolicyPending indicates Cilium has not accepted the policy yet.
	WorkspaceReasonNetworkPolicyPending = "NetworkPolicyPending"
	// WorkspaceReasonNetworkPolicyInvalid indicates Cilium rejected the isolation policy.
	WorkspaceReasonNetworkPolicyInvalid = "NetworkPolicyInvalid"
	// WorkspaceReasonCertificatePending indicates cert-manager has not issued the Workspace CA.
	WorkspaceReasonCertificatePending = "CertificatePending"
	// WorkspaceReasonCertificateInvalid indicates the Workspace CA could not be reconciled safely.
	WorkspaceReasonCertificateInvalid = "CertificateInvalid"
)

const (
	// WorkspaceNameLabel marks resources that belong to a Workspace.
	WorkspaceNameLabel = "agentz.accuknox.com/workspace"
	// WorkspaceIDAnnotation stores the immutable relational Workspace ID.
	WorkspaceIDAnnotation = "agentz.accuknox.com/workspace-id"
	// WorkspaceIsolationPolicyName is the baseline Cilium policy for a Workspace.
	WorkspaceIsolationPolicyName = "workspace-isolation"
	// WorkspacePackagePolicyName is the restricted package-job Cilium policy.
	WorkspacePackagePolicyName = "workspace-package-jobs"
)

// WorkspaceState summarizes the Workspace infrastructure lifecycle.
// +kubebuilder:validation:Enum=Provisioning;Ready;Failed;Deleting
type WorkspaceState string

const (
	// WorkspaceStateProvisioning means infrastructure is being prepared.
	WorkspaceStateProvisioning WorkspaceState = "Provisioning"
	// WorkspaceStateReady means Workspace infrastructure is ready for use.
	WorkspaceStateReady WorkspaceState = "Ready"
	// WorkspaceStateFailed means Workspace infrastructure provisioning failed.
	WorkspaceStateFailed WorkspaceState = "Failed"
	// WorkspaceStateDeleting means Workspace infrastructure is being removed.
	WorkspaceStateDeleting WorkspaceState = "Deleting"
)

// WorkspaceSpec defines the identity and provisioning attempt of a Workspace.
type WorkspaceSpec struct {
	// WorkspaceID is the immutable relational Workspace ID.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="workspaceID is immutable"
	WorkspaceID string `json:"workspaceID"`

	// OrganizationID is the immutable Better Auth Organisation ID.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="organizationID is immutable"
	OrganizationID string `json:"organizationID"`

	// ProvisioningAttempt is incremented to retry failed provisioning.
	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:XValidation:rule="self >= oldSelf",message="provisioningAttempt cannot decrease"
	ProvisioningAttempt int64 `json:"provisioningAttempt"`

	// SelectedOrganizationResources identifies the Organisation resources that
	// this Workspace may consume live and read-only.
	// +optional
	SelectedOrganizationResources SelectedOrganizationResources `json:"selectedOrganizationResources,omitempty"`
}

// SelectedOrganizationResources is the explicit Organisation resource set
// available to a Workspace. Resources created later are not selected.
type SelectedOrganizationResources struct {
	// Skills contains selected immutable Organisation Skill names.
	// +listType=set
	// +optional
	Skills []string `json:"skills,omitempty"`

	// Sandboxes contains selected Organisation Sandbox names.
	// +listType=set
	// +optional
	Sandboxes []string `json:"sandboxes,omitempty"`

	// MCPConnections contains selected Organisation MCPConnection names.
	// +listType=set
	// +optional
	MCPConnections []string `json:"mcpConnections,omitempty"`

	// InferenceProviders contains selected Organisation InferenceProvider names.
	// +listType=set
	// +optional
	InferenceProviders []string `json:"inferenceProviders,omitempty"`
}

// OrganizationResourceKind identifies a selectable Organisation resource.
type OrganizationResourceKind string

const (
	// OrganizationResourceKindSkill identifies immutable Skills.
	OrganizationResourceKindSkill OrganizationResourceKind = "Skill"
	// OrganizationResourceKindSandbox identifies Sandboxes.
	OrganizationResourceKindSandbox OrganizationResourceKind = "Sandbox"
	// OrganizationResourceKindMCPConnection identifies MCP Connections.
	OrganizationResourceKindMCPConnection OrganizationResourceKind = "MCPConnection"
	// OrganizationResourceKindInferenceProvider identifies Inference Providers.
	OrganizationResourceKindInferenceProvider OrganizationResourceKind = "InferenceProvider"
)

// Names returns the selected names for kind.
func (s SelectedOrganizationResources) Names(kind OrganizationResourceKind) []string {
	switch kind {
	case OrganizationResourceKindSkill:
		return s.Skills
	case OrganizationResourceKindSandbox:
		return s.Sandboxes
	case OrganizationResourceKindMCPConnection:
		return s.MCPConnections
	case OrganizationResourceKindInferenceProvider:
		return s.InferenceProviders
	}
	return nil
}

// Set replaces the selected names for kind.
func (s *SelectedOrganizationResources) Set(kind OrganizationResourceKind, names []string) {
	switch kind {
	case OrganizationResourceKindSkill:
		s.Skills = slices.Clone(names)
	case OrganizationResourceKindSandbox:
		s.Sandboxes = slices.Clone(names)
	case OrganizationResourceKindMCPConnection:
		s.MCPConnections = slices.Clone(names)
	case OrganizationResourceKindInferenceProvider:
		s.InferenceProviders = slices.Clone(names)
	}
}

// Equal reports whether two explicit selections contain the same ordered sets.
func (s SelectedOrganizationResources) Equal(other SelectedOrganizationResources) bool {
	return slices.Equal(s.Skills, other.Skills) &&
		slices.Equal(s.Sandboxes, other.Sandboxes) &&
		slices.Equal(s.MCPConnections, other.MCPConnections) &&
		slices.Equal(s.InferenceProviders, other.InferenceProviders)
}

// WorkspaceStatus defines the observed Workspace infrastructure state.
type WorkspaceStatus struct {
	// Namespace is the isolated Kubernetes namespace for this Workspace.
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// ObservedAttempt is the latest provisioning attempt processed.
	// +optional
	ObservedAttempt int64 `json:"observedAttempt,omitempty"`

	// State summarizes the Workspace infrastructure lifecycle.
	// +optional
	State WorkspaceState `json:"state,omitempty"`

	// Conditions represent the current Workspace infrastructure state.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// SetCondition adds or updates a condition in the status.
func (s *WorkspaceStatus) SetCondition(cond metav1.Condition) {
	apimeta.SetStatusCondition(&s.Conditions, cond)
}

// +genclient
// +genclient:nonNamespaced
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=workspace
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=`.status.state`,description="Workspace infrastructure state"
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespace`,description="Workspace namespace"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Workspace"

// Workspace is the Schema for the workspaces API.
type Workspace struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the stable Workspace identity.
	// +required
	Spec WorkspaceSpec `json:"spec"`

	// status defines the observed Workspace infrastructure state.
	// +optional
	Status WorkspaceStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// WorkspaceList contains a list of Workspace resources.
type WorkspaceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Workspace `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Workspace{}, &WorkspaceList{})
}
