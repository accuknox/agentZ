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

package agent

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/scoperesolver"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-agent,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=vagent-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Agent resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*agentzv1alpha1.Agent] = &Validator{}

// NewValidator builds an Agent validator.
func NewValidator(c client.Client) *Validator {
	return &Validator{client: c}
}

// ValidateCreate validates Agent creation.
func (v *Validator) ValidateCreate(ctx context.Context, agt *agentzv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := v.validateAgent(ctx, agt)
	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		agt.GroupVersionKind().GroupKind(),
		agt.Name,
		allErrs,
	)
}

// ValidateUpdate validates Agent updates.
func (v *Validator) ValidateUpdate(ctx context.Context, oldAgt, newAgt *agentzv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := v.validateAgent(ctx, newAgt)
	if oldAgt.Spec.NixStoreSize.Cmp(newAgt.Spec.NixStoreSize) != 0 {
		path := field.NewPath("spec").Child("nixStoreSize")
		allErrs = append(allErrs, field.Invalid(
			path,
			newAgt.Spec.NixStoreSize.String(),
			"field is immutable",
		))
	}
	if len(allErrs) == 0 {
		return nil, nil
	}

	return nil, apierrors.NewInvalid(
		newAgt.GroupVersionKind().GroupKind(),
		newAgt.Name,
		allErrs,
	)
}

// ValidateDelete validates Agent deletion.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.Agent) (admission.Warnings, error) {
	return nil, nil
}

func (v *Validator) validateAgent(ctx context.Context, agt *agentzv1alpha1.Agent) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if agt.Name == agentzv1alpha1.AgentNameMCPConnection {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("metadata").Child("name"),
			agt.Name,
			"reserved agent name",
		))
	}

	if strings.TrimSpace(agt.Spec.SandboxRef.Name) == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("sandboxRef").Child("name"),
			"field is required",
		))
	}
	if v.client != nil && agt.Spec.SandboxRef.Name != "" {
		namespace, err := scoperesolver.SelectedNamespace(ctx, v.client, agt.Namespace, scoperesolver.Selection{
			Scope: agt.Spec.SandboxRef.Scope,
			Kind:  agentzv1alpha1.OrganizationResourceKindSandbox,
			Name:  agt.Spec.SandboxRef.Name,
		})
		if err != nil {
			allErrs = append(allErrs, field.Invalid(
				specPath.Child("sandboxRef").Child("scope"),
				agt.Spec.SandboxRef.Scope,
				"scope cannot be resolved from the Agent namespace",
			))
			return allErrs
		}
		sandbox := &agentzv1alpha1.Sandbox{}
		key := client.ObjectKey{Namespace: namespace, Name: agt.Spec.SandboxRef.Name}
		err = v.client.Get(ctx, key, sandbox)
		switch {
		case apierrors.IsNotFound(err):
			allErrs = append(allErrs, field.NotFound(
				specPath.Child("sandboxRef").Child("name"), agt.Spec.SandboxRef.Name,
			))
		case err != nil:
			allErrs = append(allErrs, field.InternalError(
				specPath.Child("sandboxRef").Child("name"), fmt.Errorf("get sandbox: %w", err),
			))
		case !sandbox.DeletionTimestamp.IsZero():
			allErrs = append(allErrs, field.Forbidden(
				specPath.Child("sandboxRef").Child("name"),
				"referenced sandbox is terminating",
			))
		}
	}

	if strings.TrimSpace(agt.Spec.Instruction) == "" && agt.Spec.Instruction != "" {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("instruction"),
			agt.Spec.Instruction,
			"instruction must not be empty",
		))
	}
	if len(agt.Spec.Instruction) > 4096 {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("instruction"),
			agt.Spec.Instruction,
			"instruction must be at most 4096 characters",
		))
	}
	return allErrs
}
