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
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConditionType identifies a high-level Agent condition.
type ConditionType string

// String returns the Kubernetes condition type string.
func (c ConditionType) String() string {
	return string(c)
}

const (
	// ConditionTypeReady indicates that the Agent service is ready.
	ConditionTypeReady ConditionType = "Ready"
	// ConditionTypeProgressing indicates that the Agent is being reconciled.
	ConditionTypeProgressing ConditionType = "Progressing"
	// ConditionTypeDegraded indicates that Agent reconciliation failed.
	ConditionTypeDegraded ConditionType = "Degraded"
)

const (
	// ReasonConfigInvalid indicates the Agent spec cannot produce a runtime.
	ReasonConfigInvalid = "ConfigInvalid"
	// ReasonDeploymentCreating indicates the deployment is being created.
	ReasonDeploymentCreating = "DeploymentCreating"
	// ReasonDeploymentUpdating indicates the deployment is rolling out.
	ReasonDeploymentUpdating = "DeploymentUpdating"
	// ReasonDeploymentReady indicates the deployment has ready replicas.
	ReasonDeploymentReady = "DeploymentReady"
	// ReasonDeploymentNotReady indicates the deployment is not ready yet.
	ReasonDeploymentNotReady = "DeploymentNotReady"
	// ReasonReconcileFailed indicates an unexpected reconcile failure.
	ReasonReconcileFailed = "ReconcileFailed"
)

// AgentSpec defines the desired state of Agent.
type AgentSpec struct {
	// Image is the container image used for the Agent runtime.
	// +optional
	Image string `json:"image,omitempty"`

	// ImagePullPolicy defines when Kubernetes pulls the Agent image.
	// +kubebuilder:default=IfNotPresent
	// +optional
	ImagePullPolicy corev1.PullPolicy `json:"imagePullPolicy,omitempty"`

	// Resources defines compute resources allocated to the Agent pod.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Env defines environment variables injected into the Agent pod.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// Telemetry configures agent observability export.
	// +optional
	Telemetry TelemetryConfig `json:"telemetry,omitempty"`

	// EnvironmentRef references reusable package and policy configuration.
	// +optional
	EnvironmentRef *corev1.LocalObjectReference `json:"environmentRef,omitempty"`

	// NixStoreSize sets the size of the agent-specific nix store PVC.
	// +kubebuilder:default="5Gi"
	// +optional
	NixStoreSize resource.Quantity `json:"nixStoreSize,omitempty"`
}

// TelemetryConfig defines agent telemetry export settings.
type TelemetryConfig struct {
	// Enabled turns on OpenTelemetry trace export.
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// TraceEndpoint is the OTLP/gRPC trace endpoint in host:port form.
	// +optional
	TraceEndpoint string `json:"traceEndpoint,omitempty"`
}

// AgentStatus defines the observed state of Agent.
type AgentStatus struct {
	// Conditions represent the current state of the Agent resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ServiceName is the service exposing the Agent API.
	// +optional
	ServiceName string `json:"serviceName,omitempty"`

	// URL is the in-cluster URL of the Agent API service.
	// +optional
	URL string `json:"url,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// SetCondition adds or updates a condition in the status.
func (s *AgentStatus) SetCondition(cond metav1.Condition) {
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
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=agent
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`,description="Whether the Agent is ready"
// +kubebuilder:printcolumn:name="Service",type=string,JSONPath=`.status.serviceName`,description="Service exposing the Agent API"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the Agent"

// Agent is the Schema for the agents API.
type Agent struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Agent.
	// +required
	Spec AgentSpec `json:"spec"`

	// status defines the observed state of Agent.
	// +optional
	Status AgentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AgentList contains a list of Agent.
type AgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Agent `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Agent{}, &AgentList{})
}
