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

package mcpconn

import (
	"context"
	"net/url"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-mcpconnection,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=mcpconnections,verbs=create;update,versions=v1alpha1,name=mmcpconnection-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets default values for MCPConnection resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*agentzv1alpha1.MCPConnection] = &Defaulter{}

// NewDefaulter builds an MCPConnection defaulter.
func NewDefaulter() *Defaulter {
	return &Defaulter{}
}

// ApplyDefaults fills MCPConnection spec defaults shared by the gateway and webhook.
func ApplyDefaults(spec *agentzv1alpha1.MCPConnectionSpec) {
	if spec == nil {
		return
	}

	if parsed, err := url.Parse(strings.TrimSpace(spec.Endpoint.URL)); err == nil {
		parsed.Host = strings.ToLower(parsed.Host)
		if parsed.Scheme == "https" && parsed.Port() == "443" {
			parsed.Host = parsed.Hostname()
		}
		spec.Endpoint.URL = parsed.String()
	}

	if spec.Auth == nil {
		return
	}
}

// Default applies defaults to an MCPConnection resource.
func (d *Defaulter) Default(_ context.Context, conn *agentzv1alpha1.MCPConnection) error {
	ApplyDefaults(&conn.Spec)
	return nil
}
