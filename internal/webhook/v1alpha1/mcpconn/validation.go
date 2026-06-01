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
	"fmt"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	"github.com/accuknox/clawarmor/internal/mcp"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

var reservedAuthHeaders = map[string]struct{}{
	"Authorization":       {},
	"Proxy-Authorization": {},
	"Host":                {},
	"Content-Length":      {},
	"Transfer-Encoding":   {},
	"Connection":          {},
}

// +kubebuilder:webhook:path=/validate-clawarmor-accuknox-com-v1alpha1-mcpconnection,mutating=false,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=mcpconnections,verbs=create;update,versions=v1alpha1,name=vmcpconnection-v1alpha1.kb.io,admissionReviewVersions=v1

// Validator validates MCPConnection resources.
//
// +kubebuilder:object:generate=false
type Validator struct {
	kubeClient client.Client
}

var _ admission.Validator[*clawarmorv1alpha1.MCPConnection] = &Validator{}

// NewValidator builds an MCPConnection validator.
func NewValidator(kubeClient client.Client) *Validator {
	return &Validator{kubeClient: kubeClient}
}

// ValidateResource validates one MCPConnection resource.
func ValidateResource(conn *clawarmorv1alpha1.MCPConnection) error {
	return validateMCPConnection(conn)
}

// ValidateCreate validates MCPConnection creation.
func (v *Validator) ValidateCreate(_ context.Context, conn *clawarmorv1alpha1.MCPConnection) (admission.Warnings, error) {
	return nil, ValidateResource(conn)
}

// ValidateUpdate validates MCPConnection updates.
func (v *Validator) ValidateUpdate(_ context.Context, _, newConn *clawarmorv1alpha1.MCPConnection) (admission.Warnings, error) {
	return nil, ValidateResource(newConn)
}

// ValidateDelete validates MCPConnection deletion.
func (v *Validator) ValidateDelete(ctx context.Context, conn *clawarmorv1alpha1.MCPConnection) (admission.Warnings, error) {
	if v.kubeClient == nil {
		return nil, nil
	}

	envs := &clawarmorv1alpha1.EnvironmentList{}
	err := v.kubeClient.List(
		ctx,
		envs,
		client.InNamespace(conn.Namespace),
		client.MatchingFields{mcp.EnvironmentByMCPConnectionIndex: conn.Name},
	)
	if err != nil {
		return nil, fmt.Errorf("list referencing environments: %w", err)
	}
	if len(envs.Items) == 0 {
		return nil, nil
	}

	names := make([]string, 0, len(envs.Items))
	for _, env := range envs.Items {
		names = append(names, env.Name)
	}
	return nil, fmt.Errorf("mcp connection is referenced by environments: %s", strings.Join(names, ", "))
}

func validateMCPConnection(conn *clawarmorv1alpha1.MCPConnection) error {
	fields := field.ErrorList{}
	specPath := field.NewPath("spec")

	fields = append(fields, validateEndpoint(conn.Spec.Endpoint, specPath.Child("endpoint"))...)
	fields = append(fields, validateAuth(conn.Spec.Auth, specPath.Child("auth"))...)
	fields = append(fields, validateAuthHeaderConflicts(
		conn.Spec.Endpoint.Headers,
		conn.Spec.Auth,
		specPath,
	)...)

	if len(fields) == 0 {
		return nil
	}
	return apierrors.NewInvalid(
		conn.GroupVersionKind().GroupKind(),
		conn.Name,
		fields,
	)
}

func validateEndpoint(endpoint clawarmorv1alpha1.MCPConnectionEndpoint, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}

	rawURL := strings.TrimSpace(endpoint.URL)
	if rawURL == "" {
		fields = append(fields, field.Required(path.Child("url"), "field is required"))
		return fields
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		fields = append(fields, field.Invalid(
			path.Child("url"),
			endpoint.URL,
			fmt.Sprintf("parse url: %v", err),
		))
		return fields
	}
	if !parsed.IsAbs() {
		fields = append(fields, field.Invalid(
			path.Child("url"),
			endpoint.URL,
			"must be an absolute url",
		))
	}
	if parsed.Scheme != "https" {
		fields = append(fields, field.Invalid(
			path.Child("url"),
			endpoint.URL,
			"must use https",
		))
	}
	if strings.TrimSpace(parsed.Hostname()) == "" {
		fields = append(fields, field.Invalid(
			path.Child("url"),
			endpoint.URL,
			"must include a host",
		))
	}

	for name, value := range endpoint.Headers {
		canonicalName := textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(name))
		headerPath := path.Child("headers").Key(name)
		if canonicalName == "" {
			fields = append(fields, field.Invalid(
				headerPath,
				name,
				"header name must not be empty",
			))
			continue
		}
		if _, ok := reservedAuthHeaders[canonicalName]; ok {
			fields = append(fields, field.Invalid(
				headerPath,
				name,
				fmt.Sprintf("header %q is reserved", canonicalName),
			))
		}
		if strings.TrimSpace(value) == "" {
			fields = append(fields, field.Invalid(
				headerPath,
				value,
				"header value must not be empty",
			))
		}
	}

	return fields
}

func validateAuth(auth *clawarmorv1alpha1.MCPConnectionAuth, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if auth == nil {
		return fields
	}

	authModes := 0
	if auth.Bearer != nil {
		authModes++
		fields = append(fields, validateBearerAuth(auth.Bearer, path.Child("bearer"))...)
	}
	if auth.OAuth != nil {
		authModes++
		fields = append(fields, validateOAuthAuth(auth.OAuth, path.Child("oauth"))...)
	}
	if authModes > 1 {
		fields = append(fields, field.Invalid(
			path,
			"multiple auth modes",
			"exactly one auth mode may be configured",
		))
	}

	return fields
}

func validateBearerAuth(auth *clawarmorv1alpha1.MCPConnectionBearerAuth, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if auth.SecretRef != nil {
		fields = append(fields, validateSecretRef(auth.SecretRef, path.Child("secretRef"))...)
	}
	fields = append(fields, validateAuthLocation(auth.Location, path.Child("location"))...)
	return fields
}

func validateOAuthAuth(auth *clawarmorv1alpha1.MCPConnectionOAuthAuth, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	fields = append(fields, validateOptionalHTTPSURL(
		auth.Issuer,
		path.Child("issuer"),
	)...)
	fields = append(fields, validateOptionalHTTPSURL(
		auth.AuthorizationEndpoint,
		path.Child("authorizationEndpoint"),
	)...)
	fields = append(fields, validateOptionalHTTPSURL(
		auth.TokenEndpoint,
		path.Child("tokenEndpoint"),
	)...)
	fields = append(fields, validateOptionalHTTPSURL(
		auth.RegistrationEndpoint,
		path.Child("registrationEndpoint"),
	)...)
	fields = append(fields, validateOptionalHTTPSURL(
		auth.Resource,
		path.Child("resource"),
	)...)

	for i, scope := range auth.Scopes {
		if strings.TrimSpace(scope) == "" {
			fields = append(fields, field.Invalid(
				path.Child("scopes").Index(i),
				scope,
				"scope must not be empty",
			))
		}
	}
	if auth.SecretRef != nil {
		fields = append(fields, validateSecretRef(auth.SecretRef, path.Child("secretRef"))...)
	}
	fields = append(fields, validateAuthLocation(auth.Location, path.Child("location"))...)
	return fields
}

func validateSecretRef(ref *clawarmorv1alpha1.MCPConnectionSecretRef, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if strings.TrimSpace(ref.Path) == "" {
		fields = append(fields, field.Required(path.Child("path"), "field is required"))
	}
	if strings.TrimSpace(ref.Key) == "" {
		fields = append(fields, field.Required(path.Child("key"), "field is required"))
	}
	if ref.Path != strings.TrimSpace(ref.Path) {
		fields = append(fields, field.Invalid(
			path.Child("path"),
			ref.Path,
			"path must not contain leading or trailing whitespace",
		))
	}
	if ref.Key != strings.TrimSpace(ref.Key) {
		fields = append(fields, field.Invalid(
			path.Child("key"),
			ref.Key,
			"key must not contain leading or trailing whitespace",
		))
	}
	return fields
}

func validateAuthLocation(location *clawarmorv1alpha1.MCPConnectionAuthLocation, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if location == nil {
		return fields
	}

	var locationModes int
	if location.Header != nil {
		locationModes++
		headerName := textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(location.Header.Name))
		if headerName == "" {
			fields = append(fields, field.Required(
				path.Child("header").Child("name"),
				"field is required",
			))
		}
		if headerName != "" {
			if _, ok := reservedAuthHeaders[headerName]; ok && headerName != http.CanonicalHeaderKey(defaultAuthHeaderName) {
				fields = append(fields, field.Invalid(
					path.Child("header").Child("name"),
					location.Header.Name,
					fmt.Sprintf("header %q is reserved", headerName),
				))
			}
		}
		if location.Header.Prefix != nil && strings.TrimSpace(*location.Header.Prefix) == "" {
			fields = append(fields, field.Invalid(
				path.Child("header").Child("prefix"),
				*location.Header.Prefix,
				"prefix must not be empty",
			))
		}
	}
	if location.QueryParameter != nil {
		locationModes++
		if strings.TrimSpace(location.QueryParameter.Name) == "" {
			fields = append(fields, field.Required(
				path.Child("queryParameter").Child("name"),
				"field is required",
			))
		}
	}
	if location.Cookie != nil {
		locationModes++
		if strings.TrimSpace(location.Cookie.Name) == "" {
			fields = append(fields, field.Required(
				path.Child("cookie").Child("name"),
				"field is required",
			))
		}
	}
	if locationModes > 1 {
		fields = append(fields, field.Invalid(
			path,
			"multiple auth locations",
			"exactly one auth location may be configured",
		))
	}

	return fields
}

func validateOptionalHTTPSURL(raw string, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if strings.TrimSpace(raw) == "" {
		return fields
	}

	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		fields = append(fields, field.Invalid(
			path,
			raw,
			fmt.Sprintf("parse url: %v", err),
		))
		return fields
	}
	if !parsed.IsAbs() {
		fields = append(fields, field.Invalid(
			path,
			raw,
			"must be an absolute url",
		))
	}
	if parsed.Scheme != "https" {
		fields = append(fields, field.Invalid(
			path,
			raw,
			"must use https",
		))
	}
	if strings.TrimSpace(parsed.Hostname()) == "" {
		fields = append(fields, field.Invalid(
			path,
			raw,
			"must include a host",
		))
	}

	return fields
}

func validateAuthHeaderConflicts(headers map[string]string, auth *clawarmorv1alpha1.MCPConnectionAuth, path *field.Path) field.ErrorList {
	fields := field.ErrorList{}
	if auth == nil {
		return fields
	}

	headerName := ""
	switch {
	case auth.Bearer != nil && auth.Bearer.Location != nil && auth.Bearer.Location.Header != nil:
		headerName = auth.Bearer.Location.Header.Name
	case auth.OAuth != nil && auth.OAuth.Location != nil && auth.OAuth.Location.Header != nil:
		headerName = auth.OAuth.Location.Header.Name
	}
	if strings.TrimSpace(headerName) == "" {
		return fields
	}

	target := textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(headerName))
	for key := range headers {
		if textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(key)) != target {
			continue
		}
		fields = append(fields, field.Invalid(
			path.Child("endpoint").Child("headers").Key(key),
			key,
			fmt.Sprintf("header %q conflicts with auth insertion location", target),
		))
	}
	return fields
}
