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

package secret

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// TODO(user): change verbs to "verbs=create;update;delete" if you want to enable deletion validation.
// NOTE: If you want to customise the 'path', use the flags '--defaulting-path' or '--validation-path'.
// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-secret,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=secrets,verbs=create;update,versions=v1alpha1,name=vsecret-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator struct is responsible for validating the Secret resource
// when it is created, updated, or deleted.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as this struct is used only for temporary operations and does not need to be deeply copied.
type Validator struct {
	// TODO(user): Add more fields as needed for validation
}

var _ admission.Validator[*clawarmorv1alpha1.Secret] = &Validator{}

// NewValidator builds a Secret validator.
func NewValidator() *Validator {
	return &Validator{}
}

// ValidateCreate implements webhook.CustomValidator so a webhook will be registered for the type Secret.
func (v *Validator) ValidateCreate(_ context.Context, obj *clawarmorv1alpha1.Secret) (admission.Warnings, error) {
	secretlog.Info("Validation for Secret upon creation", "name", obj.GetName())

	// TODO(user): fill in your validation logic upon object creation.

	return nil, nil
}

// ValidateUpdate implements webhook.CustomValidator so a webhook will be registered for the type Secret.
func (v *Validator) ValidateUpdate(_ context.Context, oldObj, newObj *clawarmorv1alpha1.Secret) (admission.Warnings, error) {
	secretlog.Info("Validation for Secret upon update", "name", newObj.GetName())

	// TODO(user): fill in your validation logic upon object update.

	return nil, nil
}

// ValidateDelete implements webhook.CustomValidator so a webhook will be registered for the type Secret.
func (v *Validator) ValidateDelete(_ context.Context, obj *clawarmorv1alpha1.Secret) (admission.Warnings, error) {
	secretlog.Info("Validation for Secret upon deletion", "name", obj.GetName())

	// TODO(user): fill in your validation logic upon object deletion.

	return nil, nil
}
