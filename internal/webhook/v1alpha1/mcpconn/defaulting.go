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

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

const (
	defaultAuthHeaderName   = "Authorization"
	defaultAuthHeaderPrefix = "Bearer"
)

// +kubebuilder:webhook:path=/mutate-clawarmor-accuknox-com-v1alpha1-mcpconnection,mutating=true,failurePolicy=fail,sideEffects=None,groups=clawarmor.accuknox.com,resources=mcpconnections,verbs=create;update,versions=v1alpha1,name=mmcpconnection-v1alpha1.kb.io,admissionReviewVersions=v1

// Defaulter sets default values for MCPConnection resources.
//
// +kubebuilder:object:generate=false
type Defaulter struct{}

var _ admission.Defaulter[*clawarmorv1alpha1.MCPConnection] = &Defaulter{}

// NewDefaulter builds an MCPConnection defaulter.
func NewDefaulter() *Defaulter {
	return &Defaulter{}
}

// Default applies defaults to an MCPConnection resource.
func (d *Defaulter) Default(_ context.Context, conn *clawarmorv1alpha1.MCPConnection) error {
	if parsed, err := url.Parse(strings.TrimSpace(conn.Spec.Endpoint.URL)); err == nil {
		parsed.Host = strings.ToLower(parsed.Host)
		if parsed.Scheme == "https" && parsed.Port() == "443" {
			parsed.Host = parsed.Hostname()
		}
		conn.Spec.Endpoint.URL = parsed.String()
	}

	if conn.Spec.Auth == nil {
		return nil
	}

	if conn.Spec.Auth.Bearer != nil {
		conn.Spec.Auth.Bearer.Location = defaultAuthLocation(conn.Spec.Auth.Bearer.Location)
	}
	if conn.Spec.Auth.OAuth != nil {
		conn.Spec.Auth.OAuth.Location = defaultAuthLocation(conn.Spec.Auth.OAuth.Location)
	}
	return nil
}

func defaultAuthLocation(location *clawarmorv1alpha1.MCPConnectionAuthLocation) *clawarmorv1alpha1.MCPConnectionAuthLocation {
	if location == nil {
		location = &clawarmorv1alpha1.MCPConnectionAuthLocation{}
	}
	if location.Header == nil && location.QueryParameter == nil && location.Cookie == nil {
		prefix := defaultAuthHeaderPrefix
		location.Header = &clawarmorv1alpha1.MCPConnectionHeaderLocation{
			Name:   defaultAuthHeaderName,
			Prefix: &prefix,
		}
		return location
	}
	if location.Header == nil {
		return location
	}
	if strings.TrimSpace(location.Header.Name) == "" {
		location.Header.Name = defaultAuthHeaderName
	}
	if location.Header.Prefix == nil {
		prefix := defaultAuthHeaderPrefix
		location.Header.Prefix = &prefix
	}
	return location
}
