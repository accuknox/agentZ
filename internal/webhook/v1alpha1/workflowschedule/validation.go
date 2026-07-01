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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Validator validates WorkflowSchedule resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	gatewayClient *gatewayapi.ClientWithResponses
	tokenPath     string
}

var _ admission.Validator[*agentzv1alpha1.WorkflowSchedule] = &Validator{}

// NewValidator builds a WorkflowSchedule validator.
func NewValidator(gatewayClient *gatewayapi.ClientWithResponses, tokenPath string) *Validator {
	return &Validator{gatewayClient: gatewayClient, tokenPath: tokenPath}
}

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-workflowschedule,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=workflowschedules,verbs=create;update,versions=v1alpha1,name=vworkflowschedule-v1alpha1.kb.io,admissionReviewVersions=v1

// ValidateCreate validates WorkflowSchedule creation.
func (v *Validator) ValidateCreate(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) (admission.Warnings, error) {
	return nil, v.validateSchedule(ctx, schedule)
}

// ValidateUpdate validates WorkflowSchedule updates.
func (v *Validator) ValidateUpdate(ctx context.Context, _, newSchedule *agentzv1alpha1.WorkflowSchedule) (admission.Warnings, error) {
	return nil, v.validateSchedule(ctx, newSchedule)
}

// ValidateDelete validates WorkflowSchedule deletion.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.WorkflowSchedule) (admission.Warnings, error) {
	return nil, nil
}

func (v *Validator) validateSchedule(ctx context.Context, schedule *agentzv1alpha1.WorkflowSchedule) error {
	var fields field.ErrorList

	err := workflow.ValidateCronSchedule(schedule.Spec.Schedule)
	if err != nil {
		fields = append(fields, field.Invalid(
			field.NewPath("spec").Child("schedule"),
			schedule.Spec.Schedule,
			err.Error(),
		))
	}

	err = workflow.ValidateTimeZone(schedule.Spec.TimeZone)
	if err != nil {
		fields = append(fields, field.Invalid(
			field.NewPath("spec").Child("timeZone"),
			schedule.Spec.TimeZone,
			err.Error(),
		))
	}

	if len(fields) == 0 {
		err := workflow.ValidateInputs(
			ctx,
			v.gatewayClient,
			v.tokenPath,
			schedule.Namespace,
			schedule.GroupVersionKind().GroupKind(),
			schedule.Name,
			schedule.Spec.AgentName,
			schedule.Spec.WorkflowName,
			schedule.Spec.Inputs.Raw,
			field.NewPath("spec").Child("inputs"),
		)
		if err != nil {
			return err
		}
		return nil
	}
	return apierrors.NewInvalid(
		schedule.GroupVersionKind().GroupKind(),
		schedule.Name,
		fields,
	)
}
