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

// Package inferencepool validates tenant inference Pool resources.
package inferencepool

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/inference"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-inferencepool,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=inferencepools,verbs=create;update;delete,versions=v1alpha1,name=vinferencepool-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates InferencePool resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*agentzv1alpha1.InferencePool] = &Validator{}

// RegisterWithManager registers the InferencePool webhook.
func RegisterWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &agentzv1alpha1.InferencePool{}).
		WithValidator(&Validator{client: mgr.GetClient()}).
		Complete()
}

// ValidateCreate validates Pool membership and the derived text contract.
func (v *Validator) ValidateCreate(ctx context.Context, pool *agentzv1alpha1.InferencePool) (admission.Warnings, error) {
	return nil, v.validate(ctx, pool)
}

// ValidateUpdate validates Pool membership and the derived text contract.
func (v *Validator) ValidateUpdate(ctx context.Context, _ *agentzv1alpha1.InferencePool, pool *agentzv1alpha1.InferencePool) (admission.Warnings, error) {
	return nil, v.validate(ctx, pool)
}

// ValidateDelete rejects deletion while a Sandbox references the Pool.
func (v *Validator) ValidateDelete(ctx context.Context, pool *agentzv1alpha1.InferencePool) (admission.Warnings, error) {
	sandboxes := &agentzv1alpha1.SandboxList{}
	err := v.client.List(
		ctx,
		sandboxes,
		client.InNamespace(pool.Namespace),
		client.MatchingFields{inference.SandboxByPoolIndex: pool.Name},
	)
	if err != nil {
		return nil, fmt.Errorf("list sandboxes referencing pool: %w", err)
	}
	if len(sandboxes.Items) == 0 {
		return nil, nil
	}
	return nil, apierrors.NewForbidden(
		agentzv1alpha1.Resource("inferencepools"),
		pool.Name,
		fmt.Errorf("pool is referenced by sandbox %q", sandboxes.Items[0].Name),
	)
}

func (v *Validator) validate(ctx context.Context, pool *agentzv1alpha1.InferencePool) error {
	_, issues, err := inference.ResolvePool(ctx, v.client, pool)
	if err != nil {
		return err
	}
	fields := make(field.ErrorList, 0, len(issues))
	for _, issue := range issues {
		fields = append(fields, field.Invalid(
			field.NewPath("spec"),
			"",
			issue.Field+": "+issue.Message,
		))
	}
	if len(fields) == 0 {
		return nil
	}
	return apierrors.NewInvalid(pool.GroupVersionKind().GroupKind(), pool.Name, fields)
}
