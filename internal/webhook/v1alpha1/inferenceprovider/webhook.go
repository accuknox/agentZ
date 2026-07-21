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

// Package inferenceprovider validates tenant inference provider resources.
package inferenceprovider

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/inference"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-inferenceprovider,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=inferenceproviders,verbs=create;update,versions=v1alpha1,name=vinferenceprovider-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates InferenceProvider resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	client client.Client
}

var _ admission.Validator[*agentzv1alpha1.InferenceProvider] = &Validator{}

// RegisterWithManager registers the InferenceProvider webhook.
func RegisterWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &agentzv1alpha1.InferenceProvider{}).
		WithValidator(&Validator{client: mgr.GetClient()}).
		Complete()
}

// ValidateCreate validates provider creation.
func (v *Validator) ValidateCreate(_ context.Context, provider *agentzv1alpha1.InferenceProvider) (admission.Warnings, error) {
	return nil, invalidProvider(provider, inference.ValidateProvider(provider.Spec))
}

// ValidateUpdate validates immutable fields and referenced model removal.
func (v *Validator) ValidateUpdate(ctx context.Context, oldProvider, newProvider *agentzv1alpha1.InferenceProvider) (admission.Warnings, error) {
	fields := issuesToFields(inference.ValidateProvider(newProvider.Spec))
	if oldProvider.Spec.Kind != newProvider.Spec.Kind {
		fields = append(fields, field.Invalid(
			field.NewPath("spec").Child("kind"), newProvider.Spec.Kind, "field is immutable",
		))
	}

	modelIssues, err := inference.ValidateModelRemoval(ctx, v.client, oldProvider, newProvider)
	if err != nil {
		return nil, err
	}
	fields = append(fields, issuesToFields(modelIssues)...)
	if len(fields) == 0 {
		return nil, nil
	}
	return nil, apierrors.NewInvalid(newProvider.GroupVersionKind().GroupKind(), newProvider.Name, fields)
}

// ValidateDelete defers the authoritative reference check to the finalizer.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.InferenceProvider) (admission.Warnings, error) {
	return nil, nil
}

func invalidProvider(provider *agentzv1alpha1.InferenceProvider, issues []inference.Issue) error {
	fields := issuesToFields(issues)
	if len(fields) == 0 {
		return nil
	}
	return apierrors.NewInvalid(provider.GroupVersionKind().GroupKind(), provider.Name, fields)
}

func issuesToFields(issues []inference.Issue) field.ErrorList {
	fields := make(field.ErrorList, 0, len(issues))
	for _, issue := range issues {
		fields = append(fields, field.Invalid(
			field.NewPath("spec"), "", issue.Field+": "+issue.Message,
		))
	}
	return fields
}
