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
	// InferencePoolFinalizer prevents deletion while Sandboxes reference a Pool.
	InferencePoolFinalizer = "agentz.accuknox.com/inference-pool"
	// InferencePoolProvider is the reserved Sandbox and OpenCode provider ID.
	InferencePoolProvider = "agentz-pools"
)

// InferencePoolState summarizes reconciled control-plane readiness.
// +kubebuilder:validation:Enum=Accepted;Ready;PartiallyDegraded;Degraded
type InferencePoolState string

const (
	// InferencePoolStateAccepted means desired configuration is accepted.
	InferencePoolStateAccepted InferencePoolState = "Accepted"
	// InferencePoolStateReady means the backend and every member are ready.
	InferencePoolStateReady InferencePoolState = "Ready"
	// InferencePoolStatePartiallyDegraded means at least one member is ready.
	InferencePoolStatePartiallyDegraded InferencePoolState = "PartiallyDegraded"
	// InferencePoolStateDegraded means the backend failed or no member is ready.
	InferencePoolStateDegraded InferencePoolState = "Degraded"
)

// InferencePoolConditionType identifies Pool readiness dimensions.
type InferencePoolConditionType string

const (
	// InferencePoolConditionAccepted reports desired configuration validity.
	InferencePoolConditionAccepted InferencePoolConditionType = "Accepted"
	// InferencePoolConditionBackendReady reports AgentGateway acceptance.
	InferencePoolConditionBackendReady InferencePoolConditionType = "BackendReady"
	// InferencePoolConditionMembersReady reports member provider readiness.
	InferencePoolConditionMembersReady InferencePoolConditionType = "MembersReady"
	// InferencePoolConditionReady reports aggregate control-plane readiness.
	InferencePoolConditionReady InferencePoolConditionType = "Ready"
)

// InferenceProtocol identifies the primary request family exposed to OpenCode.
// +kubebuilder:validation:Enum=OpenAI;Anthropic
type InferenceProtocol string

const (
	// InferenceProtocolOpenAI selects OpenAI-compatible requests.
	InferenceProtocolOpenAI InferenceProtocol = "OpenAI"
	// InferenceProtocolAnthropic selects Anthropic-compatible requests.
	InferenceProtocolAnthropic InferenceProtocol = "Anthropic"
)

// InferencePoolWarningCode identifies a compatibility limitation.
// +kubebuilder:validation:Enum=MixedProtocols
type InferencePoolWarningCode string

const (
	// InferencePoolWarningMixedProtocols warns about cross-family translation.
	InferencePoolWarningMixedProtocols InferencePoolWarningCode = "MixedProtocols"
)

// InferencePoolMember references one enabled model on a provider.
type InferencePoolMember struct {
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

// InferencePoolSpec defines one logical model backed by ordered members.
// +kubebuilder:validation:XValidation:rule="self.members.all(m, self.members.exists_one(n, n.provider == m.provider && n.model == m.model))",message="pool members must be unique provider-model pairs"
type InferencePoolSpec struct {
	// DisplayName is the editable human-readable Pool label.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	DisplayName string `json:"displayName"`

	// AutomaticFailover enables passive health eviction between priority groups.
	AutomaticFailover bool `json:"automaticFailover"`

	// Members is the ordered provider-model fallback chain.
	// +listType=atomic
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=8
	Members []InferencePoolMember `json:"members"`
}

// InferencePoolContract is the conservative intersection exposed by a Pool.
type InferencePoolContract struct {
	// API is the request format accepted by every member.
	API InferenceModelAPI `json:"api"`
	// Capabilities contains features supported by every member.
	Capabilities InferenceModelCapabilities `json:"capabilities"`
	// Modalities contains media supported by every member.
	Modalities InferenceModelModalities `json:"modalities"`
	// Limits contains the minimum safe token limits across members.
	Limits InferenceModelLimits `json:"limits"`
}

// InferencePoolWarning describes a non-degrading compatibility limitation.
type InferencePoolWarning struct {
	// Code is the stable machine-readable warning identity.
	Code InferencePoolWarningCode `json:"code"`
	// Message explains the compatibility limitation.
	Message string `json:"message"`
}

// InferencePoolMemberStatus reports one member's control-plane readiness.
type InferencePoolMemberStatus struct {
	// Provider is the referenced InferenceProvider name.
	Provider string `json:"provider"`
	// Model is the referenced upstream model ID.
	Model string `json:"model"`
	// Protocol is the member's request family.
	Protocol InferenceProtocol `json:"protocol"`
	// Ready reports whether the referenced Provider is Ready.
	Ready bool `json:"ready"`
	// Reason is a stable readiness reason.
	Reason string `json:"reason"`
	// Message provides human-readable readiness detail.
	Message string `json:"message"`
}

// InferencePoolStatus defines derived Pool readiness and compatibility.
type InferencePoolStatus struct {
	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// State summarizes accepted, ready, partially degraded, or degraded state.
	// +optional
	State InferencePoolState `json:"state,omitempty"`
	// Contract is the conservative intersection of all members.
	// +optional
	Contract *InferencePoolContract `json:"contract,omitempty"`
	// Protocol is the primary member's request family.
	// +optional
	Protocol InferenceProtocol `json:"protocol,omitempty"`
	// Warnings contains non-degrading compatibility limitations.
	// +listType=map
	// +listMapKey=code
	// +optional
	Warnings []InferencePoolWarning `json:"warnings,omitempty"`
	// Members preserves desired order while reporting readiness.
	// +listType=atomic
	// +optional
	Members []InferencePoolMemberStatus `json:"members,omitempty"`
	// Conditions represent Pool readiness dimensions.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +genclient
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ipl
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=`.status.state`,description="Control-plane state"
// +kubebuilder:printcolumn:name="Failover",type=boolean,JSONPath=`.spec.automaticFailover`,description="Automatic failover"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Pool"

// InferencePool is one tenant-scoped logical model with ordered fallbacks.
type InferencePool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// Spec defines the desired Pool membership and routing behavior.
	Spec InferencePoolSpec `json:"spec"`

	// Status describes derived readiness and compatibility.
	// +optional
	Status InferencePoolStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// InferencePoolList contains InferencePool resources.
type InferencePoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []InferencePool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&InferencePool{}, &InferencePoolList{})
}
