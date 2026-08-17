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

package workflowrun

import (
	"context"
	"reflect"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// Validator validates WorkflowRun resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	gatewayClient *gatewayapi.ClientWithResponses
	tokenPath     string
}

var _ admission.Validator[*agentzv1alpha1.WorkflowRun] = &Validator{}

// NewValidator builds a WorkflowRun validator.
func NewValidator(gatewayClient *gatewayapi.ClientWithResponses, tokenPath string) *Validator {
	return &Validator{gatewayClient: gatewayClient, tokenPath: tokenPath}
}

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-workflowrun,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=workflowruns,verbs=create;update,versions=v1alpha1,name=vworkflowrun-v1alpha1.kb.io,admissionReviewVersions=v1

// ValidateCreate validates WorkflowRun creation.
func (v *Validator) ValidateCreate(ctx context.Context, run *agentzv1alpha1.WorkflowRun) (admission.Warnings, error) {
	return nil, v.validateRun(ctx, run)
}

// ValidateUpdate validates WorkflowRun updates.
func (v *Validator) ValidateUpdate(_ context.Context, oldRun, newRun *agentzv1alpha1.WorkflowRun) (admission.Warnings, error) {
	if reflect.DeepEqual(oldRun.Spec, newRun.Spec) {
		return nil, nil
	}

	fields := field.ErrorList{field.Forbidden(
		field.NewPath("spec"),
		"workflow run spec is immutable",
	)}
	return nil, apierrors.NewInvalid(
		newRun.GroupVersionKind().GroupKind(),
		newRun.Name,
		fields,
	)
}

// ValidateDelete validates WorkflowRun deletion.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.WorkflowRun) (admission.Warnings, error) {
	return nil, nil
}

func (v *Validator) validateRun(ctx context.Context, run *agentzv1alpha1.WorkflowRun) error {
	var fields field.ErrorList
	if run.Spec.ScheduleRef != nil && run.Spec.ScheduleRef.Name == "" {
		fields = append(
			fields,
			field.Invalid(
				field.NewPath("spec").Child("scheduleRef").Child("name"),
				run.Spec.ScheduleRef.Name,
				"must not be empty",
			),
		)
	}
	if len(fields) == 0 {
		err := workflow.ValidateInputs(
			ctx,
			v.gatewayClient,
			v.tokenPath,
			run.Namespace,
			run.GroupVersionKind().GroupKind(),
			run.Name,
			run.Spec.AgentName,
			run.Spec.WorkflowName,
			run.Spec.Inputs.Raw,
			field.NewPath("spec").Child("inputs"),
		)
		if err != nil {
			return err
		}
		return nil
	}
	return apierrors.NewInvalid(run.GroupVersionKind().GroupKind(), run.Name, fields)
}
