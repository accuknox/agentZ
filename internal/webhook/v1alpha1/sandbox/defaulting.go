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

package sandbox

import (
	"context"

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	envcontroller "github.com/accuknox/agentz/internal/controller/sandbox"
	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-sandbox,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=sandboxes,verbs=create;update,versions=v1alpha1,name=msandbox-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets default values for Sandbox resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*agentzv1alpha1.Sandbox] = &Defaulter{}

// NewDefaulter builds an Sandbox defaulter.
func NewDefaulter() *Defaulter {
	return &Defaulter{}
}

// Default applies defaults to an Sandbox resource.
func (d *Defaulter) Default(_ context.Context, sandbox *agentzv1alpha1.Sandbox) error {
	sandbox.Spec.Packages = envcontroller.DefaultPackagesForWebhook(sandbox.Spec.Packages)
	hosts := make([]string, 0, len(sandbox.Spec.AllowedHosts))
	seen := make(map[string]struct{}, len(sandbox.Spec.AllowedHosts))
	for _, entry := range sandbox.Spec.AllowedHosts {
		host, err := sandboxutil.ParseHost(entry)
		if err != nil {
			return nil
		}
		if _, ok := seen[host.Value]; ok {
			continue
		}
		seen[host.Value] = struct{}{}
		hosts = append(hosts, host.Value)
	}
	sandbox.Spec.AllowedHosts = hosts
	return nil
}
