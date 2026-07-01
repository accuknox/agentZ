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
	"net/url"
	"strings"

	"github.com/accuknox/agentz/internal/sinjector"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// +kubebuilder:webhook:path=/mutate-agentz-accuknox-com-v1alpha1-secret,mutating=true,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=secrets,verbs=create;update,versions=v1alpha1,name=msecret-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets shared defaults for Secret resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*agentzv1alpha1.Secret] = &Defaulter{}

// NewDefaulter builds a Secret defaulter.
func NewDefaulter() *Defaulter {
	return &Defaulter{}
}

// ApplyDefaults stabilizes Secret spec values shared by the gateway and webhook.
func ApplyDefaults(spec *agentzv1alpha1.SecretSpec) {
	if spec == nil {
		return
	}

	spec.Key = strings.TrimSpace(spec.Key)
	spec.AgentRef.Name = strings.TrimSpace(spec.AgentRef.Name)

	hosts, err := sinjector.ParseSecretHosts(spec.Hosts)
	if err == nil {
		spec.Hosts = hosts
	}

	if spec.OAuth == nil {
		return
	}

	spec.OAuth.Provider = strings.TrimSpace(spec.OAuth.Provider)
	spec.OAuth.Issuer = stableHTTPSURL(spec.OAuth.Issuer)
	spec.OAuth.AuthorizationEndpoint = stableHTTPSURL(spec.OAuth.AuthorizationEndpoint)
	spec.OAuth.TokenEndpoint = stableHTTPSURL(spec.OAuth.TokenEndpoint)
	spec.OAuth.RegistrationEndpoint = stableHTTPSURL(spec.OAuth.RegistrationEndpoint)
	spec.OAuth.Resource = stableHTTPSURL(spec.OAuth.Resource)
}

// Default applies defaults to one Secret resource.
func (d *Defaulter) Default(_ context.Context, secret *agentzv1alpha1.Secret) error {
	ApplyDefaults(&secret.Spec)
	return nil
}

func stableHTTPSURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	parsed.Host = strings.ToLower(parsed.Host)
	if parsed.Scheme == "https" && parsed.Port() == "443" {
		parsed.Host = parsed.Hostname()
	}
	return parsed.String()
}
