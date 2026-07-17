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
	k8svalidation "k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-agent,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=agents,verbs=create;update,versions=v1alpha1,name=vagent-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Agent resources.
//
// +kubebuilder:object:generate=false
type Validator struct{}

var _ admission.Validator[*agentzv1alpha1.Agent] = &Validator{}

// NewValidator builds an Agent validator.
func NewValidator() *Validator {
	return &Validator{}
}

// ValidateCreate validates Agent creation.
func (v *Validator) ValidateCreate(_ context.Context, agt *agentzv1alpha1.Agent) (admission.Warnings, error) {
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
func (v *Validator) ValidateUpdate(_ context.Context, oldAgt, newAgt *agentzv1alpha1.Agent) (admission.Warnings, error) {
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
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.Agent) (admission.Warnings, error) {
	return nil, nil
}

func validateAgent(agt *agentzv1alpha1.Agent) field.ErrorList {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	if agt.Name == agentzv1alpha1.AgentNameMCPConnection {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("metadata").Child("name"),
			agt.Name,
			"reserved agent name",
		))
	}

	if agt.Spec.SandboxRef != nil && strings.TrimSpace(agt.Spec.SandboxRef.Name) == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("sandboxRef").Child("name"),
			"field is required when sandboxRef is set",
		))
	}

	allErrs = append(allErrs, validateAgentOpencodeConfig(agt.Spec, specPath)...)

	return allErrs
}

func validateAgentOpencodeConfig(spec agentzv1alpha1.AgentSpec, path *field.Path) field.ErrorList {
	var allErrs field.ErrorList

	if spec.Model != "" && !isValidModelRef(spec.Model) {
		allErrs = append(allErrs, field.Invalid(
			path.Child("model"),
			spec.Model,
			"must be in provider/model form",
		))
	}
	if spec.SmallModel != "" && !isValidModelRef(spec.SmallModel) {
		allErrs = append(allErrs, field.Invalid(
			path.Child("smallModel"),
			spec.SmallModel,
			"must be in provider/model form",
		))
	}
	if strings.TrimSpace(spec.Instruction) == "" && spec.Instruction != "" {
		allErrs = append(allErrs, field.Invalid(
			path.Child("instruction"),
			spec.Instruction,
			"instruction must not be empty",
		))
	}
	if len(spec.Instruction) > 4096 {
		allErrs = append(allErrs, field.Invalid(
			path.Child("instruction"),
			spec.Instruction,
			"instruction must be at most 4096 characters",
		))
	}

	for name, provider := range spec.Providers {
		providerPath := path.Child("providers").Key(name)
		if strings.TrimSpace(name) == "" {
			allErrs = append(allErrs, field.Invalid(
				providerPath,
				name,
				"provider name must not be empty",
			))
		}

		for i, envName := range provider.Env {
			if strings.TrimSpace(envName) == "" {
				allErrs = append(allErrs, field.Invalid(
					providerPath.Child("env").Index(i),
					envName,
					"env var name must not be empty",
				))
				continue
			}
			if errs := k8svalidation.IsEnvVarName(envName); len(errs) > 0 {
				allErrs = append(allErrs, field.Invalid(
					providerPath.Child("env").Index(i),
					envName,
					strings.Join(errs, ", "),
				))
			}
		}

		baseURL, err := provider.ParseBaseURL()
		if err != nil {
			allErrs = append(allErrs, field.Invalid(
				providerPath.Child("baseURL"),
				provider.BaseURL,
				fmt.Sprintf("parse url: %v", err),
			))
			continue
		}
		if baseURL == nil {
			continue
		}
		if !baseURL.IsAbs() {
			allErrs = append(allErrs, field.Invalid(
				providerPath.Child("baseURL"),
				provider.BaseURL,
				"must be an absolute url",
			))
		}
	}

	return allErrs
}

func isValidModelRef(v string) bool {
	provider, model, ok := strings.Cut(v, "/")
	if !ok {
		return false
	}
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" {
		return false
	}
	return true
}
