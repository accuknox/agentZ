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
	// WorkspaceReasonNamespaceReady indicates the namespace is ready.
	WorkspaceReasonNamespaceReady = "NamespaceReady"
	// WorkspaceReasonProvisioningFailed indicates namespace provisioning failed.
	WorkspaceReasonProvisioningFailed = "ProvisioningFailed"
)

const (
	// WorkspaceNameLabel marks resources that belong to a Workspace.
	WorkspaceNameLabel = "agentz.accuknox.com/workspace"
	// WorkspaceIDAnnotation stores the immutable relational Workspace ID.
	WorkspaceIDAnnotation = "agentz.accuknox.com/workspace-id"
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
	cond.LastTransitionTime = metav1.Now()
	for i, cur := range s.Conditions {
		if cur.Type != cond.Type {
			continue
		}
		if cur.Status == cond.Status && cur.Reason == cond.Reason &&
			cur.Message == cond.Message &&
			cur.ObservedGeneration == cond.ObservedGeneration {
			cond.LastTransitionTime = cur.LastTransitionTime
		}
		s.Conditions[i] = cond
		return
	}
	s.Conditions = append(s.Conditions, cond)
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
