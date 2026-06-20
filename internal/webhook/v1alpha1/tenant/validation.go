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
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-tenant,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=tenants,verbs=create;update;delete,versions=v1alpha1,name=vtenant-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Tenant resources.
type Validator struct{}

var _ admission.Validator[*clawarmorv1alpha1.Tenant] = &Validator{}

var tenantGroupKind = schema.GroupKind{
	Group: clawarmorv1alpha1.SchemeGroupVersion.Group,
	Kind:  "Tenant",
}

// ValidateCreate validates Tenant creation.
func (v *Validator) ValidateCreate(_ context.Context, obj *clawarmorv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, validateTenant(nil, obj)
}

// ValidateUpdate validates Tenant updates.
func (v *Validator) ValidateUpdate(_ context.Context, oldObj, newObj *clawarmorv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, validateTenant(oldObj, newObj)
}

// ValidateDelete validates Tenant deletion.
func (v *Validator) ValidateDelete(_ context.Context, obj *clawarmorv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, nil
}

func validateTenant(oldObj, newObj *clawarmorv1alpha1.Tenant) error {
	issues := field.ErrorList{}
	specPath := field.NewPath("spec")

	if strings.TrimSpace(newObj.Spec.OrganizationID) == "" {
		issues = append(issues, field.Required(specPath.Child("organizationID"), "is required"))
	}
	if strings.TrimSpace(newObj.Spec.UserID) == "" {
		issues = append(issues, field.Required(specPath.Child("userID"), "is required"))
	}

	expectedName := clawarmorv1alpha1.TenantName(newObj.Spec.OrganizationID)
	if newObj.Name != expectedName {
		issues = append(issues, field.Invalid(
			field.NewPath("metadata").Child("name"),
			newObj.Name,
			fmt.Sprintf("must equal %q", expectedName),
		))
	}

	if oldObj != nil {
		if oldObj.Spec.OrganizationID != newObj.Spec.OrganizationID {
			issues = append(issues, field.Forbidden(specPath.Child("organizationID"), "is immutable"))
		}
		if oldObj.Spec.UserID != newObj.Spec.UserID {
			issues = append(issues, field.Forbidden(specPath.Child("userID"), "is immutable"))
		}
	}

	if len(issues) == 0 {
		return nil
	}
	return apierrors.NewInvalid(tenantGroupKind, newObj.Name, issues)
}
