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
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// TenantConditionReady indicates the tenant namespace is ready to use.
	TenantConditionReady = "Ready"
	// TenantConditionProgressing indicates the tenant is bootstrapping.
	TenantConditionProgressing = "Progressing"
	// TenantConditionDegraded indicates tenant bootstrap failed.
	TenantConditionDegraded = "Degraded"
	// TenantConditionQuotaSatisfied indicates Agent allocations fit within the
	// Tenant quota.
	TenantConditionQuotaSatisfied = "QuotaSatisfied"
)

const (
	// TenantReasonBootstrapping indicates bootstrap is still in progress.
	TenantReasonBootstrapping = "Bootstrapping"
	// TenantReasonNamespaceReady indicates the namespace and isolation policy
	// exist.
	TenantReasonNamespaceReady = "NamespaceReady"
	// TenantReasonBootstrapFailed indicates bootstrap failed.
	TenantReasonBootstrapFailed = "BootstrapFailed"
	// TenantReasonWithinQuota indicates Agent allocations fit within the Tenant
	// quota.
	TenantReasonWithinQuota = "WithinQuota"
	// TenantReasonAgentCountExceeded indicates more Agents exist than allowed.
	TenantReasonAgentCountExceeded = "AgentCountExceeded"
	// TenantReasonComputeQuotaExceeded indicates Agent requests exceed the
	// Tenant CPU or memory quota.
	TenantReasonComputeQuotaExceeded = "ComputeQuotaExceeded"
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

	// AgentQuota limits aggregate Agent allocations across every Workspace in
	// this Organisation. Defaults are copied to new Agents and never change
	// existing Agent resources.
	// +optional
	AgentQuota *AgentQuota `json:"agentQuota,omitempty"`

	// DashboardQuota configures dashboard definition, ingestion, and query
	// limits for Agents in this Tenant.
	// +optional
	DashboardQuota *DashboardQuota `json:"dashboardQuota,omitempty"`
}

// DashboardQuota limits dashboard definitions, ingestion, and queries.
type DashboardQuota struct {
	// DashboardsPerAgent is the maximum number of dashboards owned by one Agent.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=25
	DashboardsPerAgent int32 `json:"dashboardsPerAgent"`

	// WidgetsPerDashboard is the maximum number of widgets in one dashboard.
	// +kubebuilder:validation:Minimum=1
	WidgetsPerDashboard int32 `json:"widgetsPerDashboard"`

	// Publish limits dashboard data ingestion.
	Publish DashboardPublishQuota `json:"publish"`

	// Query limits dashboard reads.
	Query DashboardQueryQuota `json:"query"`
}

// DashboardPublishQuota limits dashboard data ingestion.
type DashboardPublishQuota struct {
	// RequestBytes is the maximum JSON request size.
	RequestBytes resource.Quantity `json:"requestBytes"`

	// RecordsPerRequest is the maximum number of records in one publish.
	// +kubebuilder:validation:Minimum=1
	RecordsPerRequest int32 `json:"recordsPerRequest"`

	// RequestsPerMinutePerAgent limits publish attempts by one Agent.
	// +kubebuilder:validation:Minimum=1
	RequestsPerMinutePerAgent int32 `json:"requestsPerMinutePerAgent"`

	// AcceptedBytesPerDay limits JSON bytes accepted from one Agent per day.
	AcceptedBytesPerDay resource.Quantity `json:"acceptedBytesPerDay"`

	// TemporalRecordsPerDay limits temporal records accepted from one Agent per day.
	// +kubebuilder:validation:Minimum=1
	TemporalRecordsPerDay int64 `json:"temporalRecordsPerDay"`

	// RetainedTemporalRecords limits temporal records retained in this Tenant.
	// +kubebuilder:validation:Minimum=1
	RetainedTemporalRecords int64 `json:"retainedTemporalRecords"`

	// LatestBytesPerAgent limits current latest-widget data owned by one Agent.
	LatestBytesPerAgent resource.Quantity `json:"latestBytesPerAgent"`
}

// DashboardQueryQuota limits dashboard reads.
type DashboardQueryQuota struct {
	// RequestsPerMinutePerUser limits query attempts by one user.
	// +kubebuilder:validation:Minimum=1
	RequestsPerMinutePerUser int32 `json:"requestsPerMinutePerUser"`

	// ReturnedCellsPerHour limits cells returned in this Tenant per hour.
	// +kubebuilder:validation:Minimum=1
	ReturnedCellsPerHour int64 `json:"returnedCellsPerHour"`

	// ConcurrentRequests limits active dashboard queries in this Tenant.
	// +kubebuilder:validation:Minimum=1
	ConcurrentRequests int32 `json:"concurrentRequests"`

	// CellsPerRequest limits cells returned by one query.
	// +kubebuilder:validation:Minimum=1
	CellsPerRequest int32 `json:"cellsPerRequest"`

	// ResponseBytes limits one encoded query response.
	ResponseBytes resource.Quantity `json:"responseBytes"`

	// PointsPerSeries limits returned points for one chart series.
	// +kubebuilder:validation:Minimum=1
	PointsPerSeries int32 `json:"pointsPerSeries"`

	// Timeout limits PostgreSQL execution time for one query.
	Timeout metav1.Duration `json:"timeout"`
}

// DashboardQuotaStatus reports the effective configured limits.
type DashboardQuotaStatus struct {
	Limits DashboardQuota `json:"limits"`
}

// ComputeResources is a CPU and memory allocation.
type ComputeResources struct {
	// CPU is measured in Kubernetes CPU units.
	CPU resource.Quantity `json:"cpu"`

	// Memory is measured in bytes using Kubernetes quantity syntax.
	Memory resource.Quantity `json:"memory"`
}

// AgentDefaults defines the resources copied to a new Agent.
type AgentDefaults struct {
	// Resources is the default whole-Pod CPU and memory allocation.
	Resources ComputeResources `json:"resources"`

	// QoSClass determines how Resources are written to a new Agent.
	// +kubebuilder:validation:Enum=Guaranteed;Burstable;BestEffort
	QoSClass corev1.PodQOSClass `json:"qosClass"`
}

// AgentQuota limits Agent count and effective CPU and memory requests.
// +kubebuilder:validation:XValidation:rule="self.count >= oldSelf.count",message="count cannot decrease"
type AgentQuota struct {
	// Count is the maximum number of Agents across the Organisation.
	// +kubebuilder:validation:Minimum=1
	Count int32 `json:"count"`

	// Resources is the Organisation-wide effective request budget.
	Resources ComputeResources `json:"resources"`

	// Defaults is copied to Agents created without explicit resources.
	Defaults AgentDefaults `json:"defaults"`
}

// QuotaCount reports Agent count consumption.
type QuotaCount struct {
	Limit     int32 `json:"limit"`
	Allocated int32 `json:"allocated"`
	Available int32 `json:"available"`
}

// QuotaResources reports CPU and memory consumption.
type QuotaResources struct {
	Limit     ComputeResources `json:"limit"`
	Allocated ComputeResources `json:"allocated"`
	Available ComputeResources `json:"available"`
}

// AgentQuotaStatus reports current Organisation-wide Agent consumption.
type AgentQuotaStatus struct {
	Count     QuotaCount     `json:"count"`
	Resources QuotaResources `json:"resources"`
}

// TenantStatus defines the observed state of Tenant.
type TenantStatus struct {
	// Namespace is the isolated Kubernetes namespace for this tenant.
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// AgentQuota reports current Agent quota consumption.
	// +optional
	AgentQuota *AgentQuotaStatus `json:"agentQuota,omitempty"`

	// DashboardQuota reports the effective dashboard limits.
	// +optional
	DashboardQuota *DashboardQuotaStatus `json:"dashboardQuota,omitempty"`

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
// +kubebuilder:printcolumn:name="Agents",type=integer,JSONPath=`.status.agentQuota.count.allocated`,description="Allocated Agents"
// +kubebuilder:printcolumn:name="Agent Limit",type=integer,JSONPath=`.status.agentQuota.count.limit`,description="Agent count limit"
// +kubebuilder:printcolumn:name="CPU Available",type=string,JSONPath=`.status.agentQuota.resources.available.cpu`,description="Available Agent CPU"
// +kubebuilder:printcolumn:name="Memory Available",type=string,JSONPath=`.status.agentQuota.resources.available.memory`,description="Available Agent memory"
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
