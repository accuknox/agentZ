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

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/agentquota"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-tenant,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=tenants,verbs=create;update;delete,versions=v1alpha1,name=vtenant-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Tenant resources.
type Validator struct {
	reader client.Reader
}

var _ admission.Validator[*agentzv1alpha1.Tenant] = &Validator{}

var tenantGroupKind = schema.GroupKind{
	Group: agentzv1alpha1.SchemeGroupVersion.Group,
	Kind:  "Tenant",
}

// ValidateCreate validates Tenant creation.
func (v *Validator) ValidateCreate(ctx context.Context, obj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, v.validateTenant(ctx, nil, obj)
}

// ValidateUpdate validates Tenant updates.
func (v *Validator) ValidateUpdate(ctx context.Context, oldObj, newObj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, v.validateTenant(ctx, oldObj, newObj)
}

// ValidateDelete validates Tenant deletion.
func (v *Validator) ValidateDelete(_ context.Context, obj *agentzv1alpha1.Tenant) (admission.Warnings, error) {
	return nil, nil
}

func (v *Validator) validateTenant(ctx context.Context, oldObj, newObj *agentzv1alpha1.Tenant) error {
	issues := field.ErrorList{}
	if oldObj == nil {
		expectedName := agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			newObj.Spec.OrganizationID,
		)
		if newObj.Name != expectedName {
			issues = append(
				issues,
				field.Invalid(
					field.NewPath("metadata").Child("name"),
					newObj.Name,
					fmt.Sprintf("must equal %q", expectedName),
				),
			)
		}
	}

	if oldObj != nil && oldObj.Spec.OrganizationID != newObj.Spec.OrganizationID {
		issues = append(
			issues,
			field.Forbidden(
				field.NewPath("spec").Child("organizationID"),
				"is immutable",
			),
		)
	}
	issues = append(issues, v.validateAgentQuota(ctx, oldObj, newObj)...)

	if len(issues) == 0 {
		return nil
	}
	return apierrors.NewInvalid(tenantGroupKind, newObj.Name, issues)
}

func (v *Validator) validateAgentQuota(ctx context.Context, oldObj, newObj *agentzv1alpha1.Tenant) field.ErrorList {
	path := field.NewPath("spec").Child("agentQuota")
	if newObj.Spec.AgentQuota == nil {
		if oldObj != nil && oldObj.Spec.AgentQuota != nil {
			return field.ErrorList{field.Forbidden(path, "cannot be removed")}
		}
		return nil
	}

	quota := newObj.Spec.AgentQuota
	issues := field.ErrorList{}
	if quota.Count < 1 {
		issues = append(issues, field.Invalid(
			path.Child("count"),
			quota.Count,
			"must be at least 1",
		))
	}
	if quota.Resources.CPU.Sign() <= 0 {
		issues = append(issues, field.Invalid(
			path.Child("resources").Child("cpu"),
			quota.Resources.CPU.String(),
			"must be positive",
		))
	}
	if quota.Resources.Memory.Sign() <= 0 {
		issues = append(issues, field.Invalid(
			path.Child("resources").Child("memory"),
			quota.Resources.Memory.String(),
			"must be positive",
		))
	}
	if quota.Defaults.Resources.CPU.Sign() <= 0 {
		issues = append(issues, field.Invalid(
			path.Child("defaults").Child("resources").Child("cpu"),
			quota.Defaults.Resources.CPU.String(),
			"must be positive",
		))
	}
	if quota.Defaults.Resources.Memory.Sign() <= 0 {
		issues = append(issues, field.Invalid(
			path.Child("defaults").Child("resources").Child("memory"),
			quota.Defaults.Resources.Memory.String(),
			"must be positive",
		))
	}
	if quota.Defaults.Resources.CPU.Cmp(quota.Resources.CPU) > 0 {
		issues = append(issues, field.Invalid(
			path.Child("defaults").Child("resources").Child("cpu"),
			quota.Defaults.Resources.CPU.String(),
			"must not exceed the Tenant CPU quota",
		))
	}
	if quota.Defaults.Resources.Memory.Cmp(quota.Resources.Memory) > 0 {
		issues = append(issues, field.Invalid(
			path.Child("defaults").Child("resources").Child("memory"),
			quota.Defaults.Resources.Memory.String(),
			"must not exceed the Tenant memory quota",
		))
	}
	switch quota.Defaults.QoSClass {
	case corev1.PodQOSGuaranteed, corev1.PodQOSBurstable, corev1.PodQOSBestEffort:
	default:
		issues = append(issues, field.NotSupported(
			path.Child("defaults").Child("qosClass"),
			quota.Defaults.QoSClass,
			[]string{
				string(corev1.PodQOSGuaranteed),
				string(corev1.PodQOSBurstable),
				string(corev1.PodQOSBestEffort),
			},
		))
	}
	if oldObj == nil || oldObj.Spec.AgentQuota == nil {
		return issues
	}
	oldQuota := oldObj.Spec.AgentQuota
	if quota.Count < oldQuota.Count {
		issues = append(issues, field.Forbidden(
			path.Child("count"),
			"cannot decrease",
		))
	}
	if v.reader == nil {
		return issues
	}
	cpuReduced := quota.Resources.CPU.Cmp(oldQuota.Resources.CPU) < 0
	memoryReduced := quota.Resources.Memory.Cmp(oldQuota.Resources.Memory) < 0
	if !cpuReduced && !memoryReduced {
		return issues
	}

	agents, err := agentquota.Agents(ctx, v.reader, newObj.Name)
	if err != nil {
		return append(issues, field.InternalError(path.Child("resources"), err))
	}
	exceeded := agentquota.Measure(agents).Exceeded(*quota)
	if cpuReduced && exceeded.CPU {
		issues = append(issues, field.Forbidden(
			path.Child("resources").Child("cpu"),
			"cannot be less than allocated Agent CPU requests",
		))
	}
	if memoryReduced && exceeded.Memory {
		issues = append(issues, field.Forbidden(
			path.Child("resources").Child("memory"),
			"cannot be less than allocated Agent memory requests",
		))
	}
	return issues
}
