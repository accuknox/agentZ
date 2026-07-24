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
	"fmt"
	"net/url"
	"regexp"
	"strings"

	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/agentz/internal/sinjector"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var secretKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// +kubebuilder:webhook:path=/validate-agentz-accuknox-com-v1alpha1-secret,mutating=false,failurePolicy=fail,sideEffects=None,groups=agentz.accuknox.com,resources=secrets,verbs=create;update,versions=v1alpha1,name=vsecret-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates Secret resources.
//
// +kubebuilder:object:generate=false
type Validator struct{}

var _ admission.Validator[*agentzv1alpha1.Secret] = &Validator{}

// NewValidator builds a Secret validator.
func NewValidator() *Validator {
	return &Validator{}
}

// Validate checks one Secret resource against the admission rules.
func Validate(secret *agentzv1alpha1.Secret) error {
	fields := validateSpec(secret.Spec, field.NewPath("spec"))
	if len(fields) == 0 {
		return nil
	}
	return apierrors.NewInvalid(secret.GroupVersionKind().GroupKind(), secret.Name, fields)
}

// ValidateCreate validates Secret creation.
func (v *Validator) ValidateCreate(_ context.Context, secret *agentzv1alpha1.Secret) (admission.Warnings, error) {
	return nil, Validate(secret)
}

// ValidateUpdate validates Secret updates.
func (v *Validator) ValidateUpdate(_ context.Context, oldSecret, newSecret *agentzv1alpha1.Secret) (admission.Warnings, error) {
	if err := Validate(newSecret); err != nil {
		return nil, err
	}

	specPath := field.NewPath("spec")
	fields := field.ErrorList{}
	if oldSecret.Spec.AgentRef.Name != newSecret.Spec.AgentRef.Name {
		fields = append(fields, field.Forbidden(specPath.Child("agentRef").Child("name"), "agentRef.name is immutable"))
	}
	if oldSecret.Spec.Key != newSecret.Spec.Key {
		fields = append(fields, field.Forbidden(specPath.Child("key"), "key is immutable"))
	}
	if oldSecret.Spec.Type != newSecret.Spec.Type {
		fields = append(fields, field.Forbidden(specPath.Child("type"), "type is immutable"))
	}
	isOAuth := oldSecret.Spec.Type == agentzv1alpha1.SecretTypeOAuth
	if isOAuth && !apiequality.Semantic.DeepEqual(oldSecret.Spec, newSecret.Spec) {
		fields = append(fields, field.Forbidden(specPath, "oauth secret spec is immutable after creation"))
	}
	if len(fields) == 0 {
		return nil, nil
	}
	return nil, apierrors.NewInvalid(newSecret.GroupVersionKind().GroupKind(), newSecret.Name, fields)
}

// ValidateDelete validates Secret deletion.
func (v *Validator) ValidateDelete(_ context.Context, _ *agentzv1alpha1.Secret) (admission.Warnings, error) {
	return nil, nil
}

func validateSpec(spec agentzv1alpha1.SecretSpec, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}

	if strings.TrimSpace(spec.AgentRef.Name) == "" {
		fields = append(fields, field.Required(path.Child("agentRef").Child("name"), "field is required"))
	}

	key := strings.TrimSpace(spec.Key)
	if key == "" {
		fields = append(fields, field.Required(path.Child("key"), "field is required"))
	}
	if len(key) > 128 {
		fields = append(fields, field.Invalid(path.Child("key"), spec.Key, "must be at most 128 characters"))
	}
	if key != "" && !secretKeyPattern.MatchString(key) {
		fields = append(fields, field.Invalid(path.Child("key"), spec.Key, "must be a valid environment variable name"))
	}

	hosts, err := sinjector.ParseSecretHosts(spec.Hosts)
	if err != nil {
		fields = append(fields, field.Invalid(path.Child("hosts"), spec.Hosts, err.Error()))
	}
	if err == nil && !apiequality.Semantic.DeepEqual(hosts, spec.Hosts) {
		fields = append(fields, field.Invalid(path.Child("hosts"), spec.Hosts, "hosts must be canonical"))
	}

	switch spec.Type {
	case agentzv1alpha1.SecretTypeStatic:
		if spec.OAuth != nil {
			fields = append(fields, field.Forbidden(path.Child("oauth"), "oauth config is only valid for oauth secrets"))
		}
	case agentzv1alpha1.SecretTypeOAuth:
		fields = append(fields, validateOAuthSpec(spec.OAuth, path.Child("oauth"))...)
	default:
		fields = append(fields, field.NotSupported(path.Child("type"), spec.Type, []string{
			string(agentzv1alpha1.SecretTypeStatic),
			string(agentzv1alpha1.SecretTypeOAuth),
		}))
	}

	return fields
}

func validateOAuthSpec(spec *agentzv1alpha1.SecretOAuthSpec, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if spec == nil {
		fields = append(fields, field.Required(path, "field is required"))
		return fields
	}

	fields = append(fields, validateOptionalHTTPSURL(spec.Issuer, path.Child("issuer"))...)
	fields = append(fields, validateOptionalHTTPSURL(spec.AuthorizationEndpoint, path.Child("authorizationEndpoint"))...)
	fields = append(fields, validateOptionalHTTPSURL(spec.TokenEndpoint, path.Child("tokenEndpoint"))...)
	fields = append(fields, validateOptionalHTTPSURL(spec.RegistrationEndpoint, path.Child("registrationEndpoint"))...)
	fields = append(fields, validateOptionalHTTPSURL(spec.Resource, path.Child("resource"))...)

	if strings.TrimSpace(spec.TokenEndpoint) == "" {
		fields = append(fields, field.Required(path.Child("tokenEndpoint"), "field is required"))
	}
	if len(spec.Scopes) == 0 {
		fields = append(fields, field.Required(path.Child("scopes"), "at least one scope is required"))
	}
	for i, scope := range spec.Scopes {
		if strings.TrimSpace(scope) == "" {
			fields = append(fields, field.Invalid(path.Child("scopes").Index(i), scope, "scope must not be empty"))
		}
	}

	return fields
}

func validateOptionalHTTPSURL(raw string, path *field.Path) field.ErrorList {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return field.ErrorList{field.Invalid(path, raw, fmt.Sprintf("parse url: %v", err))}
	}
	fields := field.ErrorList{}
	if !parsed.IsAbs() {
		fields = append(fields, field.Invalid(path, raw, "must be an absolute url"))
	}
	if parsed.Scheme != "https" {
		fields = append(fields, field.Invalid(path, raw, "must use https"))
	}
	if strings.TrimSpace(parsed.Hostname()) == "" {
		fields = append(fields, field.Invalid(path, raw, "must include a host"))
	}
	if parsed.User != nil {
		fields = append(fields, field.Invalid(path, raw, "must not include credentials"))
	}
	return fields
}
