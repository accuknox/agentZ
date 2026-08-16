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
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// SecretTypeStatic stores a static secret value in OpenBao.
	SecretTypeStatic SecretType = "Static"
	// SecretTypeOAuth stores OAuth credential material in OpenBao.
	SecretTypeOAuth SecretType = "OAuth"
)

const (
	// SecretStateAccepted means the Secret spec is accepted but runtime state is
	// not yet fully ready.
	SecretStateAccepted SecretState = "Accepted"
	// SecretStateReady means the Secret runtime is ready for use.
	SecretStateReady SecretState = "Ready"
	// SecretStateDegraded means the Secret runtime is unhealthy.
	SecretStateDegraded SecretState = "Degraded"
)

const (
	// SecretConditionAccepted means the Secret spec is accepted but runtime is
	// pending.
	SecretConditionAccepted = "Accepted"
	// SecretConditionReady means the Secret runtime is ready for use.
	SecretConditionReady = "Ready"
	// SecretConditionDegraded means the Secret runtime cannot currently be used.
	SecretConditionDegraded = "Degraded"
)

const (
	// SecretReasonAccepted reports a pending runtime record.
	SecretReasonAccepted = "Accepted"
	// SecretReasonReady reports a usable runtime record.
	SecretReasonReady = "Ready"
	// SecretReasonReconcileFailed reports manager-side runtime reconciliation
	// failure.
	SecretReasonReconcileFailed = "ReconcileFailed"
	// SecretReasonRefreshFailed reports sinjector-side OAuth token refresh
	// failure.
	SecretReasonRefreshFailed = "RefreshFailed"
)

// SecretType identifies the configured Secret kind.
type SecretType string

// SecretState identifies the observed lifecycle state of one Secret.
type SecretState string

// SecretAgentRef identifies the owning Agent.
type SecretAgentRef struct {
	// Name is the Agent name.
	Name string `json:"name"`
}

// SecretOAuthSpec defines OAuth metadata needed for runtime use.
type SecretOAuthSpec struct {
	// Provider identifies one catalog provider when known.
	// +optional
	Provider string `json:"provider,omitempty"`

	// Issuer identifies the OAuth issuer.
	// +optional
	Issuer string `json:"issuer,omitempty"`

	// AuthorizationEndpoint is the OAuth authorization endpoint.
	// +optional
	AuthorizationEndpoint string `json:"authorizationEndpoint,omitempty"`

	// TokenEndpoint is the OAuth token endpoint.
	// +optional
	TokenEndpoint string `json:"tokenEndpoint,omitempty"`

	// RegistrationEndpoint is the dynamic client registration endpoint.
	// +optional
	RegistrationEndpoint string `json:"registrationEndpoint,omitempty"`

	// Resource is the OAuth resource or audience.
	// +optional
	Resource string `json:"resource,omitempty"`

	// Scopes lists the requested OAuth scopes in order.
	// +optional
	Scopes []string `json:"scopes,omitempty"`
}

// SecretSpec defines the desired Secret state.
// +kubebuilder:validation:XValidation:rule="self.createdByUserID == oldSelf.createdByUserID",message="createdByUserID is immutable"
type SecretSpec struct {
	ResourceAudit `json:",inline"`

	// AgentRef identifies the owning Agent.
	AgentRef SecretAgentRef `json:"agentRef"`

	// Key is the logical secret name and projected environment variable name.
	Key string `json:"key"`

	// Type identifies the Secret kind.
	// +kubebuilder:validation:Enum=Static;OAuth
	Type SecretType `json:"type"`

	// Hosts defines the allowed request hosts for secret injection.
	Hosts []string `json:"hosts"`

	// OAuth configures one OAuth secret.
	// +optional
	OAuth *SecretOAuthSpec `json:"oauth,omitempty"`
}

// SecretRuntimeRef identifies the OpenBao runtime record for one Secret.
type SecretRuntimeRef struct {
	// Path is the OpenBao secret data path.
	Path string `json:"path"`
}

// SecretStatus defines the observed Secret state.
type SecretStatus struct {
	// Conditions represent the current Secret conditions.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// State is the high-level runtime state.
	// +kubebuilder:validation:Enum=Accepted;Ready;Degraded
	// +optional
	State SecretState `json:"state,omitempty"`

	// RuntimeRef identifies the OpenBao runtime record.
	// +optional
	RuntimeRef *SecretRuntimeRef `json:"runtimeRef,omitempty"`

	// LastRuntimeUpdateTime is the most recent time the runtime record changed.
	// +optional
	LastRuntimeUpdateTime *metav1.Time `json:"lastRuntimeUpdateTime,omitempty"`

	// TokenExpiryTime is the current OAuth access token expiry time.
	// +optional
	TokenExpiryTime *metav1.Time `json:"tokenExpiryTime,omitempty"`

	// LastRefreshTime is the most recent successful OAuth refresh time.
	// +optional
	LastRefreshTime *metav1.Time `json:"lastRefreshTime,omitempty"`

	// LastRefreshFailureTime is the most recent failed OAuth refresh time.
	// +optional
	LastRefreshFailureTime *metav1.Time `json:"lastRefreshFailureTime,omitempty"`

	// LastRefreshFailureReason is the most recent failed OAuth refresh reason.
	// +optional
	LastRefreshFailureReason string `json:"lastRefreshFailureReason,omitempty"`

	// LastRefreshFailureMessage is the most recent failed OAuth refresh message.
	// +optional
	LastRefreshFailureMessage string `json:"lastRefreshFailureMessage,omitempty"`
}

// SetCondition adds or updates one Secret condition.
func (s *SecretStatus) SetCondition(cond metav1.Condition) {
	apimeta.SetStatusCondition(&s.Conditions, cond)
}

// +genclient
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentRef.name`,description="Owning Agent"
// +kubebuilder:printcolumn:name="Key",type=string,JSONPath=`.spec.key`,description="Projected secret name"
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`,description="Secret type"
// +kubebuilder:printcolumn:name="Status",type=string,JSONPath=`.status.state`,description="Secret state"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Secret"

// Secret is the Schema for the secrets API.
type Secret struct {
	metav1.TypeMeta `json:",inline"`

	// Metadata is standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// Spec defines the desired Secret state.
	Spec SecretSpec `json:"spec"`

	// Status defines the observed Secret state.
	// +optional
	Status SecretStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// SecretList contains a list of Secret.
type SecretList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Secret `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Secret{}, &SecretList{})
}
