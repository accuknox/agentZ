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

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-tenant,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=tenants,verbs=create,versions=v1alpha1,name=mtenant-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter applies cluster defaults to new Tenants.
//
// +kubebuilder:object:generate=false
type Defaulter struct {
	agentQuota agentzv1alpha1.AgentQuota
}

var _ admission.Defaulter[*agentzv1alpha1.Tenant] = &Defaulter{}

// NewDefaulter builds a Tenant defaulter.
func NewDefaulter(agentQuota agentzv1alpha1.AgentQuota) *Defaulter {
	return &Defaulter{agentQuota: agentQuota}
}

// Default applies the configured quota when a Tenant omits it.
func (d *Defaulter) Default(_ context.Context, tenant *agentzv1alpha1.Tenant) error {
	if tenant.Spec.AgentQuota == nil {
		tenant.Spec.AgentQuota = d.agentQuota.DeepCopy()
	}
	return nil
}
