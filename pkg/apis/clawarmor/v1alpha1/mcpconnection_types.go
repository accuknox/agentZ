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

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

const (
	// MCPConnectionStateAccepted means the spec is accepted but runtime state is
	// not yet fully ready.
	MCPConnectionStateAccepted MCPConnectionState = "Accepted"
	// MCPConnectionStateReady means the connection is ready for use.
	MCPConnectionStateReady MCPConnectionState = "Ready"
	// MCPConnectionStateDegraded means the connection was accepted but the
	// managed runtime is unhealthy.
	MCPConnectionStateDegraded MCPConnectionState = "Degraded"
)

// MCPConnectionState identifies the observed lifecycle state of an
// MCPConnection.
type MCPConnectionState string

// MCPConnectionSpec defines the desired state of MCPConnection.
type MCPConnectionSpec struct {
	// Endpoint defines the remote MCP server endpoint and transport settings.
	Endpoint MCPConnectionEndpoint `json:"endpoint"`

	// Auth defines optional upstream authentication settings.
	// +optional
	Auth *MCPConnectionAuth `json:"auth,omitempty"`
}

// MCPConnectionEndpoint defines how to reach the upstream MCP server.
type MCPConnectionEndpoint struct {
	// URL is the canonical HTTPS URL of the upstream MCP endpoint.
	URL string `json:"url"`

	// Timeout bounds one upstream request to the MCP endpoint.
	// +optional
	Timeout *metav1.Duration `json:"timeout,omitempty"`

	// InsecureSkipVerify disables upstream TLS certificate verification.
	// +optional
	InsecureSkipVerify bool `json:"insecureSkipVerify,omitempty"`

	// Headers defines non-secret static headers sent to the upstream endpoint.
	// +optional
	Headers map[string]string `json:"headers,omitempty"`
}

// MCPConnectionAuth defines one optional upstream auth mode.
type MCPConnectionAuth struct {
	// Bearer configures static bearer-style credential injection.
	// +optional
	Bearer *MCPConnectionBearerAuth `json:"bearer,omitempty"`

	// OAuth configures OAuth-backed credential injection.
	// +optional
	OAuth *MCPConnectionOAuthAuth `json:"oauth,omitempty"`
}

// MCPConnectionBearerAuth defines static bearer credential resolution.
type MCPConnectionBearerAuth struct {
	// SecretRef identifies the canonical MCP OpenBao credential record.
	// Gateway-managed MCP connections always store credentials at
	// mcp-connections/<connection-name> under the credentials field.
	// +optional
	SecretRef *MCPConnectionSecretRef `json:"secretRef,omitempty"`

	// Location defines where the credential is injected upstream.
	// +optional
	Location *MCPConnectionAuthLocation `json:"location,omitempty"`
}

// MCPConnectionOAuthAuth defines OAuth credential resolution and metadata.
type MCPConnectionOAuthAuth struct {
	// Issuer identifies the OAuth issuer.
	// +optional
	Issuer string `json:"issuer,omitempty"`

	// AuthorizationEndpoint is the OAuth authorization endpoint.
	// +optional
	AuthorizationEndpoint string `json:"authorizationEndpoint,omitempty"`

	// TokenEndpoint is the OAuth token endpoint.
	// +optional
	TokenEndpoint string `json:"tokenEndpoint,omitempty"`

	// RegistrationEndpoint is the dynamic client registration endpoint.
	// +optional
	RegistrationEndpoint string `json:"registrationEndpoint,omitempty"`

	// Resource is the OAuth resource or audience for the MCP endpoint.
	// +optional
	Resource string `json:"resource,omitempty"`

	// Scopes lists requested OAuth scopes in order.
	// +optional
	Scopes []string `json:"scopes,omitempty"`

	// SecretRef identifies the canonical MCP OpenBao credential record.
	// Gateway-managed MCP connections always store credentials at
	// mcp-connections/<connection-name> under the credentials field.
	// +optional
	SecretRef *MCPConnectionSecretRef `json:"secretRef,omitempty"`

	// Location defines where the OAuth access token is injected upstream.
	// +optional
	Location *MCPConnectionAuthLocation `json:"location,omitempty"`
}

// MCPConnectionSecretRef identifies the canonical OpenBao record and field for
// one MCP connection credential payload.
type MCPConnectionSecretRef struct {
	// Path is the OpenBao secret data path. MCP connections use
	// mcp-connections/<connection-name>.
	Path string `json:"path"`

	// Key is the field within the OpenBao record. MCP connections use
	// credentials.
	Key string `json:"key"`
}

// MCPConnectionAuthLocation defines where auth data is injected.
type MCPConnectionAuthLocation struct {
	// Header injects auth into an HTTP header.
	// +optional
	Header *MCPConnectionHeaderLocation `json:"header,omitempty"`

	// QueryParameter injects auth into a query parameter.
	// +optional
	QueryParameter *MCPConnectionQueryParameterLocation `json:"queryParameter,omitempty"`

	// Cookie injects auth into a cookie.
	// +optional
	Cookie *MCPConnectionCookieLocation `json:"cookie,omitempty"`
}

// MCPConnectionHeaderLocation defines an auth header target.
type MCPConnectionHeaderLocation struct {
	// Name is the HTTP header name.
	Name string `json:"name"`

	// Prefix is prepended to the resolved credential when set.
	// +optional
	Prefix *string `json:"prefix,omitempty"`
}

// MCPConnectionQueryParameterLocation defines an auth query parameter target.
type MCPConnectionQueryParameterLocation struct {
	// Name is the query parameter name.
	Name string `json:"name"`
}

// MCPConnectionCookieLocation defines an auth cookie target.
type MCPConnectionCookieLocation struct {
	// Name is the cookie name.
	Name string `json:"name"`
}

// MCPConnectionStatus defines the observed state of MCPConnection.
type MCPConnectionStatus struct {
	// AuthMode is the resolved authentication mode ("None", "Bearer", or "OAuth").
	// +optional
	AuthMode string `json:"authMode,omitempty"`

	// ToolCatalogReady reports whether the most recent probe discovered the
	// upstream tool catalog successfully.
	// +optional
	ToolCatalogReady bool `json:"toolCatalogReady,omitempty"`

	// Tools lists the most recently discovered upstream MCP tools.
	// +optional
	Tools []MCPConnectionTool `json:"tools,omitempty"`

	// Conditions represent the current state of the MCPConnection resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// LastProbeTime is the most recent time an observer completed an MCP probe.
	// +optional
	LastProbeTime *metav1.Time `json:"lastProbeTime,omitempty"`

	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// State is the high-level runtime state of the connection.
	// +kubebuilder:validation:Enum=Accepted;Ready;Degraded
	// +optional
	State MCPConnectionState `json:"state,omitempty"`

	// ServiceRef identifies the managed Service that fronts the upstream
	// connection runtime.
	// +optional
	ServiceRef *MCPConnectionManagedResourceRef `json:"serviceRef,omitempty"`

	// AuthPolicyRef identifies the managed auth policy for the connection.
	// +optional
	AuthPolicyRef *MCPConnectionManagedResourceRef `json:"authPolicyRef,omitempty"`

	// ExtAuthServiceRef identifies the ext-auth Service for the
	// namespace.
	// +optional
	ExtAuthServiceRef *MCPConnectionManagedResourceRef `json:"extAuthServiceRef,omitempty"`

	// ExtAuthDeploymentRef identifies the ext-auth Deployment for the
	// namespace.
	// +optional
	ExtAuthDeploymentRef *MCPConnectionManagedResourceRef `json:"extAuthDeploymentRef,omitempty"`
}

// MCPConnectionManagedResourceRef identifies one managed Kubernetes resource.
type MCPConnectionManagedResourceRef struct {
	// Namespace is the namespace containing the managed resource.
	Namespace string `json:"namespace"`

	// Name is the resource name.
	Name string `json:"name"`
}

// MCPConnectionTool describes one discovered upstream MCP tool.
type MCPConnectionTool struct {
	// Name is the upstream MCP tool name.
	Name string `json:"name"`
}

// SetCondition adds or updates one MCPConnection condition.
func (s *MCPConnectionStatus) SetCondition(cond metav1.Condition) {
	cond.LastTransitionTime = metav1.Now()
	for i, cur := range s.Conditions {
		if cur.Type != cond.Type {
			continue
		}
		update := cur.Status == cond.Status &&
			cur.Reason == cond.Reason &&
			cur.Message == cond.Message &&
			cur.ObservedGeneration == cond.ObservedGeneration
		if update {
			cond.LastTransitionTime = cur.LastTransitionTime
		}
		s.Conditions[i] = cond
		return
	}
	s.Conditions = append(s.Conditions, cond)
}

// +genclient
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Auth Mode",type=string,JSONPath=`.status.authMode`,description="Authentication mode"
// +kubebuilder:printcolumn:name="Status",type=string,JSONPath=`.status.state`,description="Connection state"
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.spec.endpoint.url`,description="MCP endpoint URL"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the MCPConnection"

// MCPConnection is the Schema for the mcpconnections API.
type MCPConnection struct {
	metav1.TypeMeta `json:",inline"`

	// Metadata is standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// Spec defines the desired state of MCPConnection.
	Spec MCPConnectionSpec `json:"spec"`

	// Status defines the observed state of MCPConnection.
	// +optional
	Status MCPConnectionStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// MCPConnectionList contains a list of MCPConnection.
type MCPConnectionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []MCPConnection `json:"items"`
}

func init() {
	SchemeBuilder.Register(&MCPConnection{}, &MCPConnectionList{})
}
