package inference

import (
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	externalsecretsv1 "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	// ProviderLabel identifies resources owned by an InferenceProvider.
	ProviderLabel = "agentz.accuknox.com/inference-provider"
	// ProviderKindLabel identifies the provider implementation of a resource.
	ProviderKindLabel = "agentz.accuknox.com/inference-provider-kind"
	// CredentialPathDir is the fixed OpenBao subtree for provider credentials.
	CredentialPathDir = "inference-providers"

	secretAuthorization = "Authorization"
	secretCredentials   = "credentials.json"
)

// Runtime contains the concrete resources for one provider. ExternalSecret is
// nil only for an explicitly unauthenticated OpenAI-compatible provider.
type Runtime struct {
	ExternalSecret *externalsecretsv1.ExternalSecret
	Backend        *agentgatewayv1alpha1.AgentgatewayBackend
	SecretKeys     []string
}

// RenderRuntime converts an admitted provider into its complete runtime
// resources without reading credential values.
func RenderRuntime(provider *agentzv1alpha1.InferenceProvider, storeName string, refresh time.Duration) (Runtime, error) {
	labels := map[string]string{
		ProviderLabel:     provider.Name,
		ProviderKindLabel: string(provider.Spec.Kind),
	}
	backend := &agentgatewayv1alpha1.AgentgatewayBackend{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentgatewayv1alpha1.GroupVersion.String(),
			Kind:       "AgentgatewayBackend",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      provider.Name,
			Namespace: provider.Namespace,
			Labels:    labels,
		},
		Spec: agentgatewayv1alpha1.AgentgatewayBackendSpec{
			AI: &agentgatewayv1alpha1.AIBackend{
				LLM: &agentgatewayv1alpha1.LLMProvider{},
			},
		},
	}

	var extractCredentials bool
	secretKeys := map[string]string{}
	auth := &agentgatewayv1alpha1.BackendAuth{}
	secretRef := &agentgatewayv1alpha1.LocalSecretObjectRef{
		Name: gwv1.ObjectName(provider.Name),
	}
	llm := backend.Spec.AI.LLM

	switch provider.Spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		llm.OpenAI = &agentgatewayv1alpha1.OpenAIConfig{}
		secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		if provider.Spec.OpenAI.BaseURL != "" {
			err := applyEndpoint(llm, backend, provider.Spec.OpenAI.BaseURL, "", "", false)
			if err != nil {
				return Runtime{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		llm.Anthropic = &agentgatewayv1alpha1.AnthropicConfig{}
		secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-api-key", "")
		if provider.Spec.Anthropic.BaseURL != "" {
			err := applyEndpoint(llm, backend, provider.Spec.Anthropic.BaseURL, "", "", false)
			if err != nil {
				return Runtime{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindGemini:
		llm.Gemini = &agentgatewayv1alpha1.GeminiConfig{}
		secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-goog-api-key", "")
		if provider.Spec.Gemini.BaseURL != "" {
			err := applyEndpoint(llm, backend, provider.Spec.Gemini.BaseURL, "", "", false)
			if err != nil {
				return Runtime{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		llm.VertexAI = &agentgatewayv1alpha1.VertexAIConfig{
			ProjectId: provider.Spec.VertexAI.Project,
			Region:    provider.Spec.VertexAI.Region,
		}
		secretKeys[secretCredentials] = credentialServiceAccountJSON
		kind := agentgatewayv1alpha1.GcpAuthTypeAccessToken
		auth.GCP = &agentgatewayv1alpha1.GcpAuth{Type: &kind, SecretRef: secretRef}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		llm.Bedrock = &agentgatewayv1alpha1.BedrockConfig{Region: provider.Spec.Bedrock.Region}
		if provider.Spec.Bedrock.AuthMode == agentzv1alpha1.BedrockAuthModeBearerToken {
			secretKeys[secretAuthorization] = credentialBearerToken
			auth.SecretRef = secretRef
			break
		}
		secretKeys[credentialAccessKey] = credentialAccessKey
		secretKeys[credentialSecretKey] = credentialSecretKey
		extractCredentials = true
		auth.AWS = &agentgatewayv1alpha1.AwsAuth{SecretRef: secretRef}
	case agentzv1alpha1.InferenceProviderKindAzure:
		azure := provider.Spec.Azure
		llm.Azure = &agentgatewayv1alpha1.AzureConfig{
			ResourceName: azure.ResourceName,
			ResourceType: agentgatewayv1alpha1.AzureResourceType(azure.ResourceType),
		}
		if azure.Project != "" {
			value := azure.Project
			llm.Azure.ProjectName = &value
		}
		if azure.APIVersion != "" {
			value := azure.APIVersion
			llm.Azure.ApiVersion = &value
		}
		switch azure.AuthMode {
		case agentzv1alpha1.AzureAuthModeAPIKey:
			secretKeys[secretAuthorization] = credentialAPIKey
			auth.SecretRef = secretRef
			auth.Location = headerLocation("api-key", "")
		default:
			secretKeys[credentialClientID] = credentialClientID
			secretKeys[credentialTenantID] = credentialTenantID
			secretKeys[credentialClientSecret] = credentialClientSecret
			auth.Azure = &agentgatewayv1alpha1.AzureAuth{SecretRef: secretRef}
		}
	case agentzv1alpha1.InferenceProviderKindOpenAICompatible,
		agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		custom := provider.Spec.OpenAICompatible
		formats := []agentgatewayv1alpha1.ProviderFormatConfig{{
			Type: agentgatewayv1alpha1.ProviderFormatCompletions,
		}}
		if provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindAnthropicCompatible {
			custom = provider.Spec.AnthropicCompatible
			formats = []agentgatewayv1alpha1.ProviderFormatConfig{
				{Type: agentgatewayv1alpha1.ProviderFormatMessages},
				{Type: agentgatewayv1alpha1.ProviderFormatAnthropicTokenCount},
			}
		}
		llm.Custom = &agentgatewayv1alpha1.CustomProvider{
			Formats: formats,
		}
		err := applyEndpoint(
			llm, backend, custom.BaseURL, custom.Path, custom.PathPrefix,
			custom.SkipTLSVerify,
		)
		if err != nil {
			return Runtime{}, err
		}
		if custom.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeAPIKey {
			secretKeys[secretAuthorization] = credentialAPIKey
			auth.SecretRef = secretRef
			auth.Location = headerLocation(custom.AuthHeader, custom.AuthPrefix)
		}
		if len(custom.Headers) > 0 {
			set := make([]agentgatewayv1alpha1.HeaderTransformation, 0, len(custom.Headers))
			for _, header := range custom.Headers {
				set = append(set, agentgatewayv1alpha1.HeaderTransformation{
					Name:  agentgatewayv1alpha1.HeaderName(header.Name),
					Value: agentgatewayv1alpha1.CELExpression(strconv.Quote(header.Value)),
				})
			}
			if backend.Spec.Policies == nil {
				backend.Spec.Policies = &agentgatewayv1alpha1.BackendFull{}
			}
			backend.Spec.Policies.Transformation = &agentgatewayv1alpha1.Transformation{
				Request: &agentgatewayv1alpha1.Transform{Set: set},
			}
		}
	default:
		return Runtime{}, fmt.Errorf("render unsupported provider kind %q", provider.Spec.Kind)
	}

	if backend.Spec.Policies == nil {
		backend.Spec.Policies = &agentgatewayv1alpha1.BackendFull{}
	}
	backend.Spec.Policies.AI = &agentgatewayv1alpha1.BackendAI{
		Routes: map[string]agentgatewayv1alpha1.RouteType{
			"/chat/completions":      agentgatewayv1alpha1.RouteTypeCompletions,
			"/embeddings":            agentgatewayv1alpha1.RouteTypeEmbeddings,
			"/messages":              agentgatewayv1alpha1.RouteTypeMessages,
			"/messages/count_tokens": agentgatewayv1alpha1.RouteTypeAnthropicTokenCount,
			"/models":                agentgatewayv1alpha1.RouteTypeModels,
			"/realtime":              agentgatewayv1alpha1.RouteTypeRealtime,
			"/responses":             agentgatewayv1alpha1.RouteTypeResponses,
		},
	}
	if auth.SecretRef != nil || auth.AWS != nil || auth.Azure != nil || auth.GCP != nil {
		backend.Spec.Policies.Auth = auth
	}
	if len(secretKeys) == 0 {
		return Runtime{Backend: backend}, nil
	}

	data := make([]externalsecretsv1.ExternalSecretData, 0, len(secretKeys))
	path := provider.Namespace + "/" + CredentialPathDir + "/" + provider.Name
	if !extractCredentials {
		for secretKey, property := range secretKeys {
			data = append(data, externalsecretsv1.ExternalSecretData{
				SecretKey: secretKey,
				RemoteRef: externalsecretsv1.ExternalSecretDataRemoteRef{
					Key:      path,
					Property: property,
				},
			})
		}
	}
	slices.SortFunc(data, func(a, b externalsecretsv1.ExternalSecretData) int {
		return strings.Compare(a.SecretKey, b.SecretKey)
	})
	expected := make([]string, 0, len(secretKeys))
	for key := range secretKeys {
		expected = append(expected, key)
	}
	slices.Sort(expected)
	externalSecret := &externalsecretsv1.ExternalSecret{
		TypeMeta: metav1.TypeMeta{
			APIVersion: externalsecretsv1.SchemeGroupVersion.String(),
			Kind:       externalsecretsv1.ExtSecretKind,
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      provider.Name,
			Namespace: provider.Namespace,
			Labels:    labels,
		},
		Spec: externalsecretsv1.ExternalSecretSpec{
			SecretStoreRef: externalsecretsv1.SecretStoreRef{
				Name: storeName,
				Kind: externalsecretsv1.ClusterSecretStoreKind,
			},
			Target: externalsecretsv1.ExternalSecretTarget{
				Name:           provider.Name,
				CreationPolicy: externalsecretsv1.CreatePolicyOwner,
				DeletionPolicy: externalsecretsv1.DeletionPolicyDelete,
				Template: &externalsecretsv1.ExternalSecretTemplate{
					EngineVersion: externalsecretsv1.TemplateEngineV2,
					Metadata: externalsecretsv1.ExternalSecretTemplateMetadata{
						Labels: labels,
					},
				},
			},
			RefreshPolicy:   externalsecretsv1.RefreshPolicyPeriodic,
			RefreshInterval: &metav1.Duration{Duration: refresh},
			Data:            data,
		},
	}
	if extractCredentials {
		externalSecret.Spec.DataFrom = []externalsecretsv1.ExternalSecretDataFromRemoteRef{{
			Extract: &externalsecretsv1.ExternalSecretDataRemoteRef{Key: path},
		}}
	}
	return Runtime{ExternalSecret: externalSecret, Backend: backend, SecretKeys: expected}, nil
}

func applyEndpoint(llm *agentgatewayv1alpha1.LLMProvider, backend *agentgatewayv1alpha1.AgentgatewayBackend, rawURL, path, pathPrefix string, skipTLSVerify bool) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parse provider endpoint: %w", err)
	}
	port := int32(443)
	if parsed.Scheme == "http" {
		port = 80
	}
	if parsed.Port() != "" {
		value, err := strconv.ParseInt(parsed.Port(), 10, 32)
		if err != nil {
			return fmt.Errorf("parse provider endpoint port: %w", err)
		}
		port = int32(value)
	}
	llm.Host = parsed.Hostname()
	llm.Port = port
	if path == "" && pathPrefix == "" {
		pathPrefix = parsed.EscapedPath()
	}
	llm.Path = path
	llm.PathPrefix = pathPrefix
	if parsed.Scheme == "http" {
		return nil
	}
	if backend.Spec.Policies == nil {
		backend.Spec.Policies = &agentgatewayv1alpha1.BackendFull{}
	}
	backend.Spec.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
	if skipTLSVerify {
		mode := agentgatewayv1alpha1.InsecureTLSModeAll
		backend.Spec.Policies.TLS.InsecureSkipVerify = &mode
	}
	return nil
}

func headerLocation(name, prefix string) *agentgatewayv1alpha1.AuthorizationLocation {
	location := &agentgatewayv1alpha1.AuthorizationLocation{
		AuthorizationLocationFields: agentgatewayv1alpha1.AuthorizationLocationFields{
			Header: &agentgatewayv1alpha1.AuthorizationHeaderLocation{
				Name: gwv1.HTTPHeaderName(name),
			},
		},
	}
	if prefix != "" {
		location.Header.Prefix = &prefix
	}
	return location
}
