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
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// WorkflowScheduleConditionReady reflects whether the owned CronJob is ready.
	WorkflowScheduleConditionReady = "Ready"
	// WorkflowScheduleConditionProgressing reflects whether reconciliation is active.
	WorkflowScheduleConditionProgressing = "Progressing"
)

const (
	// WorkflowScheduleReasonCronJobReady indicates the CronJob matches the schedule.
	WorkflowScheduleReasonCronJobReady = "CronJobReady"
	// WorkflowScheduleReasonReconcileFailed indicates reconciliation failed.
	WorkflowScheduleReasonReconcileFailed = "ReconcileFailed"
)

// WorkflowScheduleSpec defines the desired state of WorkflowSchedule.
type WorkflowScheduleSpec struct {
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

	// Schedule is the Cron expression evaluated by Kubernetes CronJobs.
	// +kubebuilder:validation:MinLength=1
	Schedule string `json:"schedule"`

	// TimeZone controls CronJob schedule evaluation.
	// +kubebuilder:default:=UTC
	// +kubebuilder:validation:MinLength=1
	// +optional
	TimeZone string `json:"timeZone,omitempty"`

	// Inputs contains execution inputs copied into each WorkflowRun.
	// +optional
	Inputs apiextensionsv1.JSON `json:"inputs,omitempty"`

	// TimeoutSeconds bounds total execution time for one run.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=604800
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`

	// Suspend pauses future schedule ticks without deleting state.
	// +optional
	Suspend bool `json:"suspend,omitempty"`

	// SuccessfulRunsHistoryLimit retains the newest successful runs.
	// +kubebuilder:default:=3
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10
	// +optional
	SuccessfulRunsHistoryLimit *int32 `json:"successfulRunsHistoryLimit,omitempty"`

	// FailedRunsHistoryLimit retains the newest failed runs.
	// +kubebuilder:default:=3
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10
	// +optional
	FailedRunsHistoryLimit *int32 `json:"failedRunsHistoryLimit,omitempty"`
}

// WorkflowScheduleStatus defines the observed state of WorkflowSchedule.
type WorkflowScheduleStatus struct {
	// Conditions represent the current state of the WorkflowSchedule resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// CronJobName is the owned Kubernetes CronJob name.
	// +optional
	CronJobName string `json:"cronJobName,omitempty"`

	// LastScheduledAt is the latest time Kubernetes scheduled a Job.
	// +optional
	LastScheduledAt *metav1.Time `json:"lastScheduledAt,omitempty"`

	// LastRunName is the most recent owned WorkflowRun name.
	// +optional
	LastRunName string `json:"lastRunName,omitempty"`
}

// SetCondition adds or updates a WorkflowSchedule condition.
func (s *WorkflowScheduleStatus) SetCondition(cond metav1.Condition) {
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
// +kubebuilder:resource:scope=Namespaced,shortName=wfs
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentName`,description="Target agent"
// +kubebuilder:printcolumn:name="Workflow",type=string,JSONPath=`.spec.workflowName`,description="Workflow name"
// +kubebuilder:printcolumn:name="Schedule",type=string,JSONPath=`.spec.schedule`,description="Cron schedule"
// +kubebuilder:printcolumn:name="Suspended",type=boolean,JSONPath=`.spec.suspend`,description="Whether the schedule is suspended"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the WorkflowSchedule"

// WorkflowSchedule is the Schema for the workflowschedules API.
type WorkflowSchedule struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of WorkflowSchedule.
	// +required
	Spec WorkflowScheduleSpec `json:"spec"`

	// status defines the observed state of WorkflowSchedule.
	// +optional
	Status WorkflowScheduleStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// WorkflowScheduleList contains a list of WorkflowSchedule.
type WorkflowScheduleList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []WorkflowSchedule `json:"items"`
}

func init() {
	SchemeBuilder.Register(&WorkflowSchedule{}, &WorkflowScheduleList{})
}
