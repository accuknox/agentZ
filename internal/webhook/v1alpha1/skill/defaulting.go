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

package skill

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-skill,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=skills,verbs=create;update,versions=v1alpha1,name=mskill-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter struct is responsible for setting default values on the custom resource of the
// Kind Skill when those are created or updated.
//
// NOTE: The +kubebuilder:object:generate=false marker prevents controller-gen from generating DeepCopy methods,
// as it is used only for temporary operations and does not need to be deeply copied.
type Defaulter struct {
	// TODO(user): Add more fields as needed for defaulting
}

var _ admission.Defaulter[*agentzv1alpha1.Skill] = &Defaulter{}

// Default implements webhook.CustomDefaulter so a webhook will be registered for the Kind Skill.
func (d *Defaulter) Default(_ context.Context, obj *agentzv1alpha1.Skill) error {
	skilllog.Info("Defaulting for Skill", "name", obj.GetName())

	// TODO(user): fill in your defaulting logic.

	return nil
}
