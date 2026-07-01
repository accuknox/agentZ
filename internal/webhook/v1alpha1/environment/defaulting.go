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

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	envcontroller "github.com/accuknox/agentz/internal/controller/environment"
	"github.com/accuknox/agentz/internal/envutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-environment,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=envs,verbs=create;update,versions=v1alpha1,name=menvironment-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets default values for Environment resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*agentzv1alpha1.Environment] = &Defaulter{}

// NewDefaulter builds an Environment defaulter.
func NewDefaulter() *Defaulter {
	return &Defaulter{}
}

// Default applies defaults to an Environment resource.
func (d *Defaulter) Default(_ context.Context, env *agentzv1alpha1.Environment) error {
	env.Spec.Packages = envcontroller.DefaultPackagesForWebhook(env.Spec.Packages)
	hosts := make([]string, 0, len(env.Spec.AllowedHosts))
	seen := make(map[string]struct{}, len(env.Spec.AllowedHosts))
	for _, entry := range env.Spec.AllowedHosts {
		host, err := envutil.ParseHost(entry)
		if err != nil {
			return nil
		}
		if _, ok := seen[host.Value]; ok {
			continue
		}
		seen[host.Value] = struct{}{}
		hosts = append(hosts, host.Value)
	}
	env.Spec.AllowedHosts = hosts
	return nil
}
