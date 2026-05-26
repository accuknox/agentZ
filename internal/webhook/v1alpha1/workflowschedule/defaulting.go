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

package workflowschedule

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	defaultWorkflowScheduleTimeoutSeconds int32 = 3600
	defaultSuccessfulRunsHistoryLimit     int32 = 3
	defaultFailedRunsHistoryLimit         int32 = 3
)

// Defaulter applies defaults to WorkflowSchedule resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*clawarmorv1alpha1.WorkflowSchedule] = &Defaulter{}

// +kubebuilder:webhook:path=/mutate-clawarmor-accuknox-com-v1alpha1-workflowschedule,mutating=true,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=workflowschedules,verbs=create;update,versions=v1alpha1,name=mworkflowschedule-v1alpha1.kb.io,admissionReviewVersions=v1

// Default applies defaults to a WorkflowSchedule resource.
func (d *Defaulter) Default(_ context.Context, schedule *clawarmorv1alpha1.WorkflowSchedule) error {
	if schedule.Spec.TimeoutSeconds == 0 {
		schedule.Spec.TimeoutSeconds = defaultWorkflowScheduleTimeoutSeconds
	}
	if schedule.Spec.SuccessfulRunsHistoryLimit == nil {
		schedule.Spec.SuccessfulRunsHistoryLimit = new(defaultSuccessfulRunsHistoryLimit)
	}
	if schedule.Spec.FailedRunsHistoryLimit == nil {
		schedule.Spec.FailedRunsHistoryLimit = new(defaultFailedRunsHistoryLimit)
	}
	return nil
}
