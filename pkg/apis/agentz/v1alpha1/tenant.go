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
	// TenantConditionReady indicates the tenant namespace is ready to use.
	TenantConditionReady = "Ready"
	// TenantConditionProgressing indicates the tenant is bootstrapping.
	TenantConditionProgressing = "Progressing"
	// TenantConditionDegraded indicates tenant bootstrap failed.
	TenantConditionDegraded = "Degraded"
)

const (
	// TenantReasonBootstrapping indicates bootstrap is still in progress.
	TenantReasonBootstrapping = "Bootstrapping"
	// TenantReasonNamespaceReady indicates the namespace and isolation policy
	// exist.
	TenantReasonNamespaceReady = "NamespaceReady"
	// TenantReasonBootstrapFailed indicates bootstrap failed.
	TenantReasonBootstrapFailed = "BootstrapFailed"
)

const (
	// TenantManagedByLabel marks resources managed by AgentZ.
	TenantManagedByLabel = "app.kubernetes.io/managed-by"
	// TenantManagedByValue is the AgentZ manager label value.
	TenantManagedByValue = "agentz"
	// TenantNameLabel marks resources that belong to a Tenant.
	TenantNameLabel = "agentz.accuknox.com/tenant"
	// TenantOrganizationIDLabel indexes Tenants by the deterministic,
	// label-safe hash of their Better Auth Organisation ID.
	TenantOrganizationIDLabel = "agentz.accuknox.com/organization-id-hash"
	// TenantOrganizationIDAnnotation stores the Better Auth organization ID.
	TenantOrganizationIDAnnotation = "agentz.accuknox.com/organization-id"
	// TenantIsolationPolicyName is the Cilium policy name used for tenant
	// isolation.
	TenantIsolationPolicyName = "tenant-isolation"
	// KubeArmorVisibilityAnnotation is the annotation key for setting
	// KubeArmor visibility on namespaces and pods.
	KubeArmorVisibilityAnnotation = "kubearmor-visibility"
)

// TenantSpec defines the desired state of Tenant.
type TenantSpec struct {
	// OrganizationID is the immutable Better Auth Organisation ID represented by
	// this Tenant.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="organizationID is immutable"
	OrganizationID string `json:"organizationID"`
}

// TenantStatus defines the observed state of Tenant.
type TenantStatus struct {
	// Namespace is the isolated Kubernetes namespace for this tenant.
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions represent the current state of the Tenant resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// SetCondition adds or updates a condition in the status.
func (s *TenantStatus) SetCondition(cond metav1.Condition) {
	apimeta.SetStatusCondition(&s.Conditions, cond)
}

// +genclient
// +genclient:nonNamespaced
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=tenant
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`,description="Whether the Tenant is ready"
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespace`,description="Tenant namespace"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Tenant"

// Tenant is the Schema for the tenants API.
type Tenant struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Tenant.
	// +required
	Spec TenantSpec `json:"spec"`

	// status defines the observed state of Tenant.
	// +optional
	Status TenantStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// TenantList contains a list of Tenant.
type TenantList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Tenant `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Tenant{}, &TenantList{})
}
