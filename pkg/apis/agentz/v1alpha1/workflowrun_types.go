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
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// WorkflowRunPhaseUnknown is the zero value for WorkflowRun phase.
	WorkflowRunPhaseUnknown WorkflowRunPhase = ""
	// WorkflowRunPhasePending means the run has not started execution yet.
	WorkflowRunPhasePending WorkflowRunPhase = "Pending"
	// WorkflowRunPhaseRunning means the run has an active OpenCode session.
	WorkflowRunPhaseRunning WorkflowRunPhase = "Running"
	// WorkflowRunPhaseUnacked means the session completed without a terminal status update.
	WorkflowRunPhaseUnacked WorkflowRunPhase = "Unacked"
	// WorkflowRunPhaseSucceeded means the run completed successfully.
	WorkflowRunPhaseSucceeded WorkflowRunPhase = "Succeeded"
	// WorkflowRunPhaseFailed means the run completed unsuccessfully.
	WorkflowRunPhaseFailed WorkflowRunPhase = "Failed"
)

const (
	// WorkflowRunConditionReady reflects whether the run reached a terminal state.
	WorkflowRunConditionReady = "Ready"
	// WorkflowRunConditionProgressing reflects whether the run is active.
	WorkflowRunConditionProgressing = "Progressing"
)

const (
	// WorkflowRunReasonPending indicates the run is queued for execution.
	WorkflowRunReasonPending = "Pending"
	// WorkflowRunReasonSessionRunning indicates the agent is executing the workflow.
	WorkflowRunReasonSessionRunning = "SessionRunning"
	// WorkflowRunReasonUnacked indicates the workflow completed without a terminal status update.
	WorkflowRunReasonUnacked = "Unacked"
	// WorkflowRunReasonSucceeded indicates the workflow finished successfully.
	WorkflowRunReasonSucceeded = "Succeeded"
	// WorkflowRunReasonFailed indicates the workflow finished unsuccessfully.
	WorkflowRunReasonFailed = "Failed"
	// WorkflowRunReasonTimedOut indicates the run exceeded its timeout.
	WorkflowRunReasonTimedOut = "TimedOut"
	// WorkflowRunReasonGatewayError indicates the gateway call failed.
	WorkflowRunReasonGatewayError = "GatewayError"
)

// WorkflowRunAnnotationWebhookAPIKeyID stores the Better Auth API key ID that
// created one webhook-triggered run.
const WorkflowRunAnnotationWebhookAPIKeyID = "agentz.accuknox.com/webhook-api-key-id"

// WorkflowRunPhase identifies the lifecycle state of a WorkflowRun.
type WorkflowRunPhase string

// Terminal returns true when the phase is terminal.
func (p WorkflowRunPhase) Terminal() bool {
	return p == WorkflowRunPhaseSucceeded ||
		p == WorkflowRunPhaseFailed ||
		p == WorkflowRunPhaseUnacked
}

// WorkflowRunSpec defines the desired state of WorkflowRun.
type WorkflowRunSpec struct {
	// AgentName identifies the target AgentZ Agent.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	AgentName string `json:"agentName"`

	// WorkflowName identifies the saved workflow definition for the Agent.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	WorkflowName string `json:"workflowName"`

	// Inputs contains execution inputs copied into this run.
	// +optional
	Inputs apiextensionsv1.JSON `json:"inputs,omitempty"`

	// TimeoutSeconds bounds total execution time for one run.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=604800
	// +optional
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`

	// ScheduleRef points back to the owning WorkflowSchedule when created by cron.
	// +optional
	ScheduleRef *corev1.LocalObjectReference `json:"scheduleRef,omitempty"`
}

// WorkflowRunStatus defines the observed state of WorkflowRun.
type WorkflowRunStatus struct {
	// Phase is the lifecycle state tracked by controllers and the agent.
	// +kubebuilder:validation:Enum=Pending;Running;Unacked;Succeeded;Failed
	// +optional
	Phase WorkflowRunPhase `json:"phase,omitempty"`

	// Conditions represent the current state of the WorkflowRun resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// SessionID is the OpenCode session created for this run.
	// +optional
	SessionID string `json:"sessionID,omitempty"`

	// StartedAt is when the controller started execution.
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`

	// CompletedAt is when the run reached a terminal state.
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`

	// Message contains the current error or completion summary.
	// +optional
	Message string `json:"message,omitempty"`
}

// SetCondition adds or updates a WorkflowRun condition.
func (s *WorkflowRunStatus) SetCondition(cond metav1.Condition) {
	cond.LastTransitionTime = metav1.Now()
	for i, cur := range s.Conditions {
		if cur.Type != cond.Type {
			continue
		}
		if cur.Status == cond.Status && cur.Reason == cond.Reason && cur.Message == cond.Message && cur.ObservedGeneration == cond.ObservedGeneration {
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
// +kubebuilder:resource:scope=Namespaced,shortName=wfr
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentName`,description="Target agent"
// +kubebuilder:printcolumn:name="Workflow",type=string,JSONPath=`.spec.workflowName`,description="Workflow name"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`,description="Execution phase"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the WorkflowRun"

// WorkflowRun is the Schema for the workflowruns API.
type WorkflowRun struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of WorkflowRun.
	// +required
	Spec WorkflowRunSpec `json:"spec"`

	// status defines the observed state of WorkflowRun.
	// +optional
	Status WorkflowRunStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// WorkflowRunList contains a list of WorkflowRun.
type WorkflowRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []WorkflowRun `json:"items"`
}

func init() {
	SchemeBuilder.Register(&WorkflowRun{}, &WorkflowRunList{})
}
