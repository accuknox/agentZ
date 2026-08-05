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

package workspace

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-workspace,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=workspaces,verbs=create;update;delete,versions=v1alpha1,name=vworkspace-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Workspace resources.
type Validator struct{}

var _ admission.Validator[*agentzv1alpha1.Workspace] = &Validator{}

var workspaceGroupKind = schema.GroupKind{
	Group: agentzv1alpha1.SchemeGroupVersion.Group,
	Kind:  "Workspace",
}

// ValidateCreate validates Workspace creation.
func (v *Validator) ValidateCreate(_ context.Context, obj *agentzv1alpha1.Workspace) (admission.Warnings, error) {
	return nil, validateWorkspace(obj)
}

// ValidateUpdate validates Workspace updates.
func (v *Validator) ValidateUpdate(_ context.Context, _, newObj *agentzv1alpha1.Workspace) (admission.Warnings, error) {
	return nil, validateWorkspace(newObj)
}

// ValidateDelete validates Workspace deletion.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.Workspace) (admission.Warnings, error) {
	return nil, nil
}

func validateWorkspace(obj *agentzv1alpha1.Workspace) error {
	expectedName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		obj.Spec.WorkspaceID,
	)
	if obj.Name == expectedName {
		return nil
	}
	return apierrors.NewInvalid(workspaceGroupKind, obj.Name, field.ErrorList{
		field.Invalid(
			field.NewPath("metadata").Child("name"),
			obj.Name,
			fmt.Sprintf("must equal %q", expectedName),
		),
	})
}
