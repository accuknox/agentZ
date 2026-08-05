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
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-tenant,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=tenants,verbs=create;update;delete,versions=v1alpha1,name=vtenant-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Tenant resources.
type Validator struct{}

var _ admission.Validator[*agentzv1alpha1.Tenant] = &Validator{}

var tenantGroupKind = schema.GroupKind{
	Group: agentzv1alpha1.SchemeGroupVersion.Group,
	Kind:  "Tenant",
}

// ValidateCreate validates Tenant creation.
func (v *Validator) ValidateCreate(_ context.Context, obj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, validateTenant(nil, obj)
}

// ValidateUpdate validates Tenant updates.
func (v *Validator) ValidateUpdate(_ context.Context, oldObj, newObj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, validateTenant(oldObj, newObj)
}

// ValidateDelete validates Tenant deletion.
func (v *Validator) ValidateDelete(_ context.Context, obj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, nil
}

func validateTenant(oldObj, newObj *agentzv1alpha1.Tenant) error {
	issues := field.ErrorList{}
	if oldObj == nil {
		expectedName := agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			newObj.Spec.OrganizationID,
		)
		if newObj.Name == expectedName {
			return nil
		}
		issues = append(issues, field.Invalid(
			field.NewPath("metadata").Child("name"),
			newObj.Name,
			fmt.Sprintf("must equal %q", expectedName),
		))
	}

	if oldObj != nil && oldObj.Spec.OrganizationID != newObj.Spec.OrganizationID {
		issues = append(issues, field.Forbidden(
			field.NewPath("spec").Child("organizationID"),
			"is immutable",
		))
	}

	if len(issues) == 0 {
		return nil
	}
	return apierrors.NewInvalid(tenantGroupKind, newObj.Name, issues)
}
