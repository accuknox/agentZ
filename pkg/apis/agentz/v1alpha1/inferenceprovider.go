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

// InferenceProviderKind identifies the configuration and credentials required
// by an upstream inference protocol.
// +kubebuilder:validation:Enum=OpenAI;OpenAICodex;Anthropic;Gemini;GitHubCopilot;OpenAICompatible;AnthropicCompatible;Bedrock;VertexAI;Azure
type InferenceProviderKind string

const (
	// InferenceProviderKindOpenAI identifies the native OpenAI provider.
	InferenceProviderKindOpenAI InferenceProviderKind = "OpenAI"
	// InferenceProviderKindOpenAICodex identifies a ChatGPT Codex subscription.
	InferenceProviderKindOpenAICodex InferenceProviderKind = "OpenAICodex"
	// InferenceProviderKindAnthropic identifies the native Anthropic provider.
	InferenceProviderKindAnthropic InferenceProviderKind = "Anthropic"
	// InferenceProviderKindGemini identifies the native Gemini provider.
	InferenceProviderKindGemini InferenceProviderKind = "Gemini"
	// InferenceProviderKindGitHubCopilot identifies a GitHub Copilot subscription.
	InferenceProviderKindGitHubCopilot InferenceProviderKind = "GitHubCopilot"
	// InferenceProviderKindVertexAI identifies the native Vertex AI provider.
	InferenceProviderKindVertexAI InferenceProviderKind = "VertexAI"
	// InferenceProviderKindBedrock identifies the native Amazon Bedrock provider.
	InferenceProviderKindBedrock InferenceProviderKind = "Bedrock"
	// InferenceProviderKindAzure identifies the native Azure resource provider.
	InferenceProviderKindAzure InferenceProviderKind = "Azure"
	// InferenceProviderKindOpenAICompatible identifies a custom OpenAI endpoint.
	InferenceProviderKindOpenAICompatible InferenceProviderKind = "OpenAICompatible"
	// InferenceProviderKindAnthropicCompatible identifies a custom Anthropic endpoint.
	InferenceProviderKindAnthropicCompatible InferenceProviderKind = "AnthropicCompatible"
)

// InferenceModelAPI identifies the upstream API used for one model.
// +kubebuilder:validation:Enum=ChatCompletions;Responses;Messages
type InferenceModelAPI string

const (
	// InferenceModelAPIChatCompletions selects OpenAI Chat Completions.
	InferenceModelAPIChatCompletions InferenceModelAPI = "ChatCompletions"
	// InferenceModelAPIResponses selects OpenAI Responses.
	InferenceModelAPIResponses InferenceModelAPI = "Responses"
	// InferenceModelAPIMessages selects Anthropic Messages.
	InferenceModelAPIMessages InferenceModelAPI = "Messages"
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

	// API records the subscription provider API selected during discovery.
	// +optional
	API *InferenceModelAPI `json:"api,omitempty"`

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

// GeminiProviderConfig contains non-secret native Gemini endpoint controls.
type GeminiProviderConfig struct {
	// BaseURL overrides the native Gemini endpoint when set.
	// +kubebuilder:validation:MaxLength=2048
	// +kubebuilder:validation:Format=uri
	// +optional
	BaseURL string `json:"baseURL,omitempty"`
}

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

// BedrockAuthMode selects AWS signing or Bedrock bearer-token authentication.
// +kubebuilder:validation:Enum=AccessKey;BearerToken
type BedrockAuthMode string

const (
	// BedrockAuthModeAccessKey signs requests with AWS credentials.
	BedrockAuthModeAccessKey BedrockAuthMode = "AccessKey"
	// BedrockAuthModeBearerToken sends a Bedrock API key as a bearer token.
	BedrockAuthModeBearerToken BedrockAuthMode = "BearerToken"
)

// BedrockProviderConfig contains non-secret native Bedrock settings.
type BedrockProviderConfig struct {
	// Region is the AWS region used for SigV4 signing and dispatch.
	// +kubebuilder:validation:Pattern=`^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$`
	Region string `json:"region"`

	// AuthMode selects the credential shape used for Bedrock.
	AuthMode BedrockAuthMode `json:"authMode"`
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

// CompatibleProviderAuthMode selects custom API-key or unauthenticated access.
// +kubebuilder:validation:Enum=None;APIKey
type CompatibleProviderAuthMode string

const (
	// CompatibleProviderAuthModeNone disables upstream authentication.
	CompatibleProviderAuthModeNone CompatibleProviderAuthMode = "None"
	// CompatibleProviderAuthModeAPIKey injects a configured API key.
	CompatibleProviderAuthModeAPIKey CompatibleProviderAuthMode = "APIKey"
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

// CompatibleProviderConfig contains safe custom endpoint controls.
// +kubebuilder:validation:XValidation:rule="self.authMode == 'APIKey' ? has(self.authHeader) : !has(self.authHeader) && !has(self.authPrefix)",message="authentication header and prefix require API-key authentication"
type CompatibleProviderConfig struct {
	// BaseURL is the compatible endpoint.
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
	AuthMode CompatibleProviderAuthMode `json:"authMode"`

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
// +kubebuilder:validation:XValidation:rule="self.kind == oldSelf.kind",message="provider kind is immutable"
// +kubebuilder:validation:XValidation:rule="self.kind == 'OpenAI' ? has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="OpenAI kind requires only openAI configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'Anthropic' ? has(self.anthropic) && !has(self.openAI) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="Anthropic kind requires only anthropic configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'Gemini' ? has(self.gemini) && !has(self.openAI) && !has(self.anthropic) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="Gemini kind requires only gemini configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'OpenAICompatible' ? has(self.openAICompatible) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="OpenAICompatible kind requires only openAICompatible configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'AnthropicCompatible' ? has(self.anthropicCompatible) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="AnthropicCompatible kind requires only anthropicCompatible configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'Bedrock' ? has(self.bedrock) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.vertexAI) && !has(self.azure) : true",message="Bedrock kind requires only bedrock configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'VertexAI' ? has(self.vertexAI) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.azure) : true",message="VertexAI kind requires only vertexAI configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'Azure' ? has(self.azure) && !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) : true",message="Azure kind requires only azure configuration"
// +kubebuilder:validation:XValidation:rule="self.kind == 'OpenAICodex' || self.kind == 'GitHubCopilot' ? !has(self.openAI) && !has(self.anthropic) && !has(self.gemini) && !has(self.openAICompatible) && !has(self.anthropicCompatible) && !has(self.bedrock) && !has(self.vertexAI) && !has(self.azure) : true",message="subscription provider kinds do not accept endpoint configuration"
type InferenceProviderSpec struct {
	// CatalogProvider is the immutable OpenCode provider ID or custom.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="catalog provider is immutable"
	CatalogProvider string `json:"catalogProvider"`

	// DisplayName is the editable human-readable provider label.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	DisplayName string `json:"displayName"`

	// Kind selects the immutable provider configuration arm.
	Kind InferenceProviderKind `json:"kind"`

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
	OpenAICompatible *CompatibleProviderConfig `json:"openAICompatible,omitempty"`

	// AnthropicCompatible configures a custom Anthropic-compatible endpoint.
	// +optional
	AnthropicCompatible *CompatibleProviderConfig `json:"anthropicCompatible,omitempty"`

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
// +kubebuilder:printcolumn:name="Kind",type=string,JSONPath=`.spec.kind`,description="Provider kind"
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
