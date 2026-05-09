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
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-agent,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=vagent-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Agent resources.
//
// +kubebuilder:object:generate=false
type Validator struct{}

var _ admission.Validator[*clawarmorv1alpha1.Agent] = &Validator{}

// NewValidator builds an Agent validator.
func NewValidator() *Validator {
	return &Validator{}
}

// ValidateCreate validates Agent creation.
func (v *Validator) ValidateCreate(_ context.Context, agt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := validateAgent(agt)
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
func (v *Validator) ValidateUpdate(_ context.Context, oldAgt, newAgt *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	allErrs := validateAgent(newAgt)
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
func (v *Validator) ValidateDelete(_ context.Context, _ *clawarmorv1alpha1.Agent) (admission.Warnings, error) {
	return nil, nil
}

func validateAgent(agt *clawarmorv1alpha1.Agent) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if agt.Spec.EnvironmentRef != nil && strings.TrimSpace(agt.Spec.EnvironmentRef.Name) == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("environmentRef").Child("name"),
			"field is required when environmentRef is set",
		))
	}

	return allErrs
}
