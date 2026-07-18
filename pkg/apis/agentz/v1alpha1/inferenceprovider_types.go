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
	// InferenceProviderFinalizer protects credentials and referenced providers.
	InferenceProviderFinalizer = "agentz.accuknox.com/inference-provider"
)

// InferenceProviderType identifies an upstream inference protocol and vendor.
// +kubebuilder:validation:Enum=OpenAI;Anthropic;Gemini;VertexAI;Bedrock;Azure;OpenAICompatible
type InferenceProviderType string

const (
	// InferenceProviderTypeOpenAI identifies the native OpenAI provider.
	InferenceProviderTypeOpenAI InferenceProviderType = "OpenAI"
	// InferenceProviderTypeAnthropic identifies the native Anthropic provider.
	InferenceProviderTypeAnthropic InferenceProviderType = "Anthropic"
	// InferenceProviderTypeGemini identifies the native Gemini provider.
	InferenceProviderTypeGemini InferenceProviderType = "Gemini"
	// InferenceProviderTypeVertexAI identifies the native Vertex AI provider.
	InferenceProviderTypeVertexAI InferenceProviderType = "VertexAI"
	// InferenceProviderTypeBedrock identifies the native Amazon Bedrock provider.
	InferenceProviderTypeBedrock InferenceProviderType = "Bedrock"
	// InferenceProviderTypeAzure identifies the native Azure resource provider.
	InferenceProviderTypeAzure InferenceProviderType = "Azure"
	// InferenceProviderTypeOpenAICompatible identifies a custom OpenAI endpoint.
	InferenceProviderTypeOpenAICompatible InferenceProviderType = "OpenAICompatible"
)

// InferenceProviderState summarizes reconciled control-plane readiness.
// +kubebuilder:validation:Enum=Accepted;Ready;Degraded
type InferenceProviderState string

const (
	// InferenceProviderStateAccepted means desired configuration is accepted.
	InferenceProviderStateAccepted InferenceProviderState = "Accepted"
	// InferenceProviderStateReady means reconciled dependencies are ready.
	InferenceProviderStateReady InferenceProviderState = "Ready"
	// InferenceProviderStateDegraded means a dependency or configuration failed.
	InferenceProviderStateDegraded InferenceProviderState = "Degraded"
)

// InferenceProviderConditionType identifies provider readiness dimensions.
type InferenceProviderConditionType string

const (
	// InferenceProviderConditionAccepted reports desired configuration validity.
	InferenceProviderConditionAccepted InferenceProviderConditionType = "Accepted"
	// InferenceProviderConditionCredentialsReady reports credential materialization.
	InferenceProviderConditionCredentialsReady InferenceProviderConditionType = "CredentialsReady"
	// InferenceProviderConditionBackendReady reports AgentGateway acceptance.
	InferenceProviderConditionBackendReady InferenceProviderConditionType = "BackendReady"
	// InferenceProviderConditionReady reports aggregate control-plane readiness.
	InferenceProviderConditionReady InferenceProviderConditionType = "Ready"
)

// InferenceModelModality describes input and output media understood by OpenCode.
// +kubebuilder:validation:Enum=text;audio;image;video;pdf
type InferenceModelModality string

const (
	// InferenceModelModalityText identifies text media.
	InferenceModelModalityText InferenceModelModality = "text"
	// InferenceModelModalityAudio identifies audio media.
	InferenceModelModalityAudio InferenceModelModality = "audio"
	// InferenceModelModalityImage identifies image media.
	InferenceModelModalityImage InferenceModelModality = "image"
	// InferenceModelModalityVideo identifies video media.
	InferenceModelModalityVideo InferenceModelModality = "video"
	// InferenceModelModalityPDF identifies PDF media.
	InferenceModelModalityPDF InferenceModelModality = "pdf"
)

// InferenceModel describes one immutable upstream model identifier and its
// saved OpenCode metadata.
// +kubebuilder:validation:XValidation:rule="!has(self.limits.input) || self.limits.input <= self.limits.context",message="maximum input tokens cannot exceed context tokens"
// +kubebuilder:validation:XValidation:rule="self.limits.output <= self.limits.context",message="maximum output tokens cannot exceed context tokens"
type InferenceModel struct {
	// ID is the exact upstream model or deployment identifier.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="model id is immutable"
	ID string `json:"id"`

	// DisplayName is the editable model label shown to users.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	DisplayName string `json:"displayName"`

	// Capabilities controls OpenCode model behavior.
	Capabilities InferenceModelCapabilities `json:"capabilities"`

	// Modalities lists the model's supported media.
	Modalities InferenceModelModalities `json:"modalities"`

	// Limits records the model's token limits.
	Limits InferenceModelLimits `json:"limits"`

	// Catalog records advisory Models.dev provenance when selected there.
	// +optional
	Catalog *InferenceModelCatalog `json:"catalog,omitempty"`
}

// InferenceModelCapabilities describes operational model behavior used by OpenCode.
type InferenceModelCapabilities struct {
	// Attachment reports whether file attachments are supported.
	Attachment bool `json:"attachment"`
	// Reasoning reports whether reasoning controls are supported.
	Reasoning bool `json:"reasoning"`
	// Temperature reports whether temperature controls are supported.
	Temperature bool `json:"temperature"`
	// ToolCall reports whether tool calls are supported.
	ToolCall bool `json:"toolCall"`
}

// InferenceModelModalities describes supported model input and output media.
type InferenceModelModalities struct {
	// Input lists supported input media.
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=5
	// +listType=set
	Input []InferenceModelModality `json:"input"`

	// Output lists supported output media.
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=5
	// +listType=set
	Output []InferenceModelModality `json:"output"`
}

// InferenceModelLimits records positive token limits used by OpenCode.
type InferenceModelLimits struct {
	// Context is the total context-window size.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=2147483647
	Context int32 `json:"context"`

	// Input is the optional maximum input-token count.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=2147483647
	// +optional
	Input *int32 `json:"input,omitempty"`

	// Output is the maximum output-token count.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=2147483647
	Output int32 `json:"output"`
}

// InferenceModelCatalog identifies the advisory catalog entry copied on save.
type InferenceModelCatalog struct {
	// Provider is the Models.dev provider identifier.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	Provider string `json:"provider"`
}

// OpenAIProviderConfig contains non-secret native OpenAI endpoint controls.
type OpenAIProviderConfig struct {
	// BaseURL overrides the native OpenAI endpoint when set.
	// +kubebuilder:validation:MaxLength=2048
	// +kubebuilder:validation:Format=uri
	// +optional
	BaseURL string `json:"baseURL,omitempty"`
}

// AnthropicProviderConfig contains non-secret native Anthropic endpoint controls.
type AnthropicProviderConfig struct {
	// BaseURL overrides the native Anthropic endpoint when set.
	// +kubebuilder:validation:MaxLength=2048
	// +kubebuilder:validation:Format=uri
	// +optional
	BaseURL string `json:"baseURL,omitempty"`
}

// GeminiProviderConfig selects AgentGateway's native Gemini provider.
type GeminiProviderConfig struct{}

// VertexAIProviderConfig contains non-secret native Vertex AI settings.
type VertexAIProviderConfig struct {
	// Project is the Google Cloud project identifier.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	Project string `json:"project"`

	// Region is the Google Cloud region.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	Region string `json:"region"`
}

// BedrockProviderConfig contains non-secret native Bedrock settings.
type BedrockProviderConfig struct {
	// Region is the AWS region used for SigV4 signing and dispatch.
	// +kubebuilder:validation:Pattern=`^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$`
	Region string `json:"region"`
}

// AzureResourceType selects Azure OpenAI or Azure AI Foundry.
// +kubebuilder:validation:Enum=OpenAI;Foundry
type AzureResourceType string

const (
	// AzureResourceTypeOpenAI selects an Azure OpenAI resource.
	AzureResourceTypeOpenAI AzureResourceType = "OpenAI"
	// AzureResourceTypeFoundry selects an Azure AI Foundry project.
	AzureResourceTypeFoundry AzureResourceType = "Foundry"
)

// AzureAuthMode selects Azure API-key or service-principal authentication.
// +kubebuilder:validation:Enum=APIKey;ServicePrincipal
type AzureAuthMode string

const (
	// AzureAuthModeAPIKey selects API-key authentication.
	AzureAuthModeAPIKey AzureAuthMode = "APIKey"
	// AzureAuthModeServicePrincipal selects OAuth service-principal authentication.
	AzureAuthModeServicePrincipal AzureAuthMode = "ServicePrincipal"
)

// AzureProviderConfig contains non-secret Azure resource settings.
// +kubebuilder:validation:XValidation:rule="self.resourceType == 'Foundry' ? has(self.project) : !has(self.project)",message="project is required only for Foundry resources"
type AzureProviderConfig struct {
	// ResourceType selects Azure OpenAI or Azure AI Foundry.
	ResourceType AzureResourceType `json:"resourceType"`

	// ResourceName is the Azure AI resource name.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	ResourceName string `json:"resourceName"`

	// Project is required for Azure AI Foundry.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	// +optional
	Project string `json:"project,omitempty"`

	// APIVersion selects the Azure inference API version.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	APIVersion string `json:"apiVersion"`

	// AuthMode selects the credential shape used by AgentGateway.
	AuthMode AzureAuthMode `json:"authMode"`
}

// OpenAICompatibleAuthMode selects custom API-key or unauthenticated access.
// +kubebuilder:validation:Enum=None;APIKey
type OpenAICompatibleAuthMode string

const (
	// OpenAICompatibleAuthModeNone disables upstream authentication.
	OpenAICompatibleAuthModeNone OpenAICompatibleAuthMode = "None"
	// OpenAICompatibleAuthModeAPIKey injects a configured API key.
	OpenAICompatibleAuthModeAPIKey OpenAICompatibleAuthMode = "APIKey"
)

// InferenceProviderHeader is one non-secret custom upstream header.
type InferenceProviderHeader struct {
	// Name is the lowercase HTTP header name.
	// +kubebuilder:validation:Pattern=`^[a-z0-9!#$%&'*+.^_|~-]+$`
	// +kubebuilder:validation:MaxLength=128
	Name string `json:"name"`

	// Value is the non-secret header value.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=1024
	// +kubebuilder:validation:Pattern=`^[^\x00-\x08\x0A-\x1F\x7F]*$`
	Value string `json:"value"`
}

// OpenAICompatibleProviderConfig contains safe custom endpoint controls.
// +kubebuilder:validation:XValidation:rule="self.authMode == 'APIKey' ? has(self.authHeader) : !has(self.authHeader) && !has(self.authPrefix)",message="authentication header and prefix require API-key authentication"
type OpenAICompatibleProviderConfig struct {
	// BaseURL is the custom OpenAI-compatible endpoint.
	// +kubebuilder:validation:Format=uri
	// +kubebuilder:validation:MaxLength=2048
	BaseURL string `json:"baseURL"`

	// Path replaces the provider request path when set.
	// +kubebuilder:validation:Pattern=`^/[^?#]*$`
	// +kubebuilder:validation:MaxLength=1024
	// +optional
	Path string `json:"path,omitempty"`

	// PathPrefix replaces the default provider API prefix when set.
	// +kubebuilder:validation:Pattern=`^/[^?#]*$`
	// +kubebuilder:validation:MaxLength=1024
	// +optional
	PathPrefix string `json:"pathPrefix,omitempty"`

	// AuthMode selects API-key or unauthenticated access.
	AuthMode OpenAICompatibleAuthMode `json:"authMode"`

	// AuthHeader is the lowercase destination header for the API key.
	// +kubebuilder:validation:Pattern=`^[a-z0-9!#$%&'*+.^_|~-]+$`
	// +kubebuilder:validation:MaxLength=128
	// +optional
	AuthHeader string `json:"authHeader,omitempty"`

	// AuthPrefix is prepended to the API key at the controlled upstream hop.
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[^\x00-\x08\x0A-\x1F\x7F]*$`
	// +optional
	AuthPrefix string `json:"authPrefix,omitempty"`

	// Headers contains non-secret upstream headers.
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=32
	// +optional
	Headers []InferenceProviderHeader `json:"headers,omitempty"`

	// AllowPrivateEndpoint explicitly permits private endpoints or plain HTTP.
	// +optional
	AllowPrivateEndpoint bool `json:"allowPrivateEndpoint,omitempty"`

	// SkipTLSVerify explicitly disables upstream TLS certificate verification.
	// +optional
	SkipTLSVerify bool `json:"skipTLSVerify,omitempty"`
}

// InferenceProviderSpec defines one credentialed provider instance.
// +kubebuilder:validation:XValidation:rule="self.type == oldSelf.type",message="provider type is immutable"
// +kubebuilder:validation:XValidation:rule="self.type == 'OpenAI' ? has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.vertexAI) && !has(self.bedrock) && !has(self.azure) && !has(self.openAICompatible) : true",message="OpenAI type requires only openAI configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'Anthropic' ? has(self.anthropic) && !has(self.openAI) && !has(self.gemini) && !has(self.vertexAI) && !has(self.bedrock) && !has(self.azure) && !has(self.openAICompatible) : true",message="Anthropic type requires only anthropic configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'Gemini' ? has(self.gemini) && !has(self.openAI) && !has(self.anthropic) && !has(self.vertexAI) && !has(self.bedrock) && !has(self.azure) && !has(self.openAICompatible) : true",message="Gemini type requires only gemini configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'VertexAI' ? has(self.vertexAI) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.bedrock) && !has(self.azure) && !has(self.openAICompatible) : true",message="VertexAI type requires only vertexAI configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'Bedrock' ? has(self.bedrock) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.vertexAI) && !has(self.azure) && !has(self.openAICompatible) : true",message="Bedrock type requires only bedrock configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'Azure' ? has(self.azure) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.vertexAI) && !has(self.bedrock) && !has(self.openAICompatible) : true",message="Azure type requires only azure configuration"
// +kubebuilder:validation:XValidation:rule="self.type == 'OpenAICompatible' ? has(self.openAICompatible) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.vertexAI) && !has(self.bedrock) && !has(self.azure) : true",message="OpenAICompatible type requires only openAICompatible configuration"
type InferenceProviderSpec struct {
	// DisplayName is the editable human-readable provider label.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	DisplayName string `json:"displayName"`

	// Type selects the immutable provider configuration arm.
	Type InferenceProviderType `json:"type"`

	// OpenAI configures native OpenAI.
	// +optional
	OpenAI *OpenAIProviderConfig `json:"openAI,omitempty"`

	// Anthropic configures native Anthropic.
	// +optional
	Anthropic *AnthropicProviderConfig `json:"anthropic,omitempty"`

	// Gemini configures native Gemini.
	// +optional
	Gemini *GeminiProviderConfig `json:"gemini,omitempty"`

	// VertexAI configures native Vertex AI.
	// +optional
	VertexAI *VertexAIProviderConfig `json:"vertexAI,omitempty"`

	// Bedrock configures native Amazon Bedrock.
	// +optional
	Bedrock *BedrockProviderConfig `json:"bedrock,omitempty"`

	// Azure configures Azure OpenAI or Azure AI Foundry.
	// +optional
	Azure *AzureProviderConfig `json:"azure,omitempty"`

	// OpenAICompatible configures a custom OpenAI-compatible endpoint.
	// +optional
	OpenAICompatible *OpenAICompatibleProviderConfig `json:"openAICompatible,omitempty"`

	// Models lists the explicitly enabled upstream models.
	// +listType=map
	// +listMapKey=id
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=500
	Models []InferenceModel `json:"models"`
}

// InferenceProviderStatus defines observed control-plane readiness.
type InferenceProviderStatus struct {
	// ObservedGeneration is the latest reconciled generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// State summarizes accepted, ready, or degraded state.
	// +optional
	State InferenceProviderState `json:"state,omitempty"`

	// ModelCount is the number of enabled upstream models.
	// +optional
	ModelCount int `json:"modelCount,omitempty"`

	// Conditions represent provider readiness dimensions.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +genclient
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ip
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`,description="Provider type"
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=`.status.state`,description="Control-plane state"
// +kubebuilder:printcolumn:name="Models",type=integer,JSONPath=`.status.modelCount`,description="Enabled model count"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`,description="Age of the provider"

// InferenceProvider is one tenant-scoped upstream provider instance.
type InferenceProvider struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// Spec defines the desired provider and model configuration.
	Spec InferenceProviderSpec `json:"spec"`

	// Status describes the observed provider runtime.
	// +optional
	Status InferenceProviderStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// InferenceProviderList contains InferenceProvider resources.
type InferenceProviderList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []InferenceProvider `json:"items"`
}

func init() {
	SchemeBuilder.Register(&InferenceProvider{}, &InferenceProviderList{})
}
