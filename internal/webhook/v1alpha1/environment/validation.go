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

package environment

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/api/v1alpha1"
	"github.com/accuknox/clawarmor/internal/envutil"
)

var log = logf.Log.WithName("environment-resource")

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-environment,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=envs,verbs=create;update;delete,versions=v1alpha1,name=venvironment-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Environment resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*clawarmorv1alpha1.Environment] = &Validator{}

// NewValidator builds an Environment validator.
func NewValidator(c client.Client) *Validator {
	return &Validator{client: c}
}

// ValidateCreate validates Environment creation.
func (v *Validator) ValidateCreate(_ context.Context, env *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	return nil, validateAllowedHosts(env)
}

// ValidateUpdate validates Environment updates.
func (v *Validator) ValidateUpdate(_ context.Context, _, newEnv *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	return nil, validateAllowedHosts(newEnv)
}

// ValidateDelete validates Environment deletion.
func (v *Validator) ValidateDelete(ctx context.Context, env *clawarmorv1alpha1.Environment) (admission.Warnings, error) {
	log.Info("Validation for Environment upon deletion", "name", env.GetName())
	if v.client == nil {
		return nil, nil
	}

	agentName, err := envutil.ReferencingAgentName(
		ctx,
		v.client,
		env.Namespace,
		env.Name,
	)
	if err != nil {
		return nil, err
	}
	if agentName == "" {
		return nil, nil
	}

	path := field.NewPath("metadata").Child("name")
	return nil, apierrors.NewInvalid(
		env.GroupVersionKind().GroupKind(),
		env.Name,
		field.ErrorList{field.Forbidden(
			path,
			"environment is referenced by agent "+agentName,
		)},
	)
}

func validateAllowedHosts(env *clawarmorv1alpha1.Environment) error {
	var fields field.ErrorList
	path := field.NewPath("spec").Child("allowedHosts")
	for i, entry := range env.Spec.AllowedHosts {
		if _, err := envutil.ParseHost(entry); err != nil {
			fields = append(fields, field.Invalid(
				path.Index(i),
				entry,
				fmt.Sprintf("%v", err),
			))
		}
	}
	if len(fields) == 0 {
		return nil
	}
	return apierrors.NewInvalid(env.GroupVersionKind().GroupKind(), env.Name, fields)
}
