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

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-clawarmor-accuknox-com-v1alpha1-tenant,mutating=true,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=tenants,verbs=create;update,versions=v1alpha1,name=mtenant-v1alpha1.kb.io,admissionReviewVersions=v1

// TenantCustomDefaulter struct is responsible for setting default values on the custom resource of the
// Kind Tenant when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type Defaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

var _ admission.Defaulter[*clawarmorv1alpha1.Tenant] = &Defaulter{}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind Tenant.
func (d *Defaulter) Default(_ context.Context, obj *clawarmorv1alpha1.Tenant) error {
	tenantlog.Info("Defaulting for Tenant", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}
