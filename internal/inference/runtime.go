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

// ProviderTarget contains one provider's complete member-scoped AgentGateway
// configuration. Model is empty for direct provider backends and set for Pool
// members so the logical Pool ID never reaches an upstream.
type ProviderTarget struct {
	LLM      agentgatewayv1alpha1.LLMProvider
	Policies *agentgatewayv1alpha1.BackendWithAI

	secretKeys         map[string]string
	extractCredentials bool
}

// RenderRuntime converts an admitted provider into its complete runtime
// resources without reading credential values.
func RenderRuntime(provider *agentzv1alpha1.InferenceProvider, storeName string, refresh time.Duration) (Runtime, error) {
	target, err := RenderProviderTarget(provider, "")
	if err != nil {
		return Runtime{}, err
	}
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
				LLM: &target.LLM,
			},
			Policies: &agentgatewayv1alpha1.BackendFull{
				BackendSimple:  target.Policies.BackendSimple,
				AI:             target.Policies.AI,
				Transformation: target.Policies.Transformation,
			},
		},
	}
	if target.Policies.TLS == nil && target.Policies.Auth == nil &&
		target.Policies.Transformation == nil {
		backend.Spec.Policies = &agentgatewayv1alpha1.BackendFull{AI: target.Policies.AI}
	}
	if len(target.secretKeys) == 0 {
		return Runtime{Backend: backend, SecretKeys: []string{}}, nil
	}

	data := make([]externalsecretsv1.ExternalSecretData, 0, len(target.secretKeys))
	path := provider.Namespace + "/" + CredentialPathDir + "/" + provider.Name
	if !target.extractCredentials {
		for secretKey, property := range target.secretKeys {
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
	expected := make([]string, 0, len(target.secretKeys))
	for key := range target.secretKeys {
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
	if target.extractCredentials {
		externalSecret.Spec.DataFrom = []externalsecretsv1.ExternalSecretDataFromRemoteRef{{
			Extract: &externalsecretsv1.ExternalSecretDataRemoteRef{Key: path},
		}}
	}
	return Runtime{ExternalSecret: externalSecret, Backend: backend, SecretKeys: expected}, nil
}

// RenderProviderTarget converts an admitted provider into one reusable target.
// The optional model override binds a Pool member to its real upstream model.
func RenderProviderTarget(provider *agentzv1alpha1.InferenceProvider, model string) (ProviderTarget, error) {
	target := ProviderTarget{
		Policies:   &agentgatewayv1alpha1.BackendWithAI{},
		secretKeys: map[string]string{},
	}
	auth := &agentgatewayv1alpha1.BackendAuth{}
	secretRef := &agentgatewayv1alpha1.LocalSecretObjectRef{
		Name: gwv1.ObjectName(provider.Name),
	}
	var modelRef *agentgatewayv1alpha1.ShortString
	if model != "" {
		modelRef = &model
	}

	switch provider.Spec.Kind {
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		target.LLM.OpenAI = &agentgatewayv1alpha1.OpenAIConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		if provider.Spec.OpenAI.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.OpenAI.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		target.LLM.Anthropic = &agentgatewayv1alpha1.AnthropicConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-api-key", "")
		if provider.Spec.Anthropic.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.Anthropic.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindGemini:
		target.LLM.Gemini = &agentgatewayv1alpha1.GeminiConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-goog-api-key", "")
		if provider.Spec.Gemini.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.Gemini.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		target.LLM.VertexAI = &agentgatewayv1alpha1.VertexAIConfig{
			Model:     modelRef,
			ProjectId: provider.Spec.VertexAI.Project,
			Region:    provider.Spec.VertexAI.Region,
		}
		target.secretKeys[secretCredentials] = credentialServiceAccountJSON
		kind := agentgatewayv1alpha1.GcpAuthTypeAccessToken
		auth.GCP = &agentgatewayv1alpha1.GcpAuth{Type: &kind, SecretRef: secretRef}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		target.LLM.Bedrock = &agentgatewayv1alpha1.BedrockConfig{
			Region: provider.Spec.Bedrock.Region,
			Model:  modelRef,
		}
		if provider.Spec.Bedrock.AuthMode == agentzv1alpha1.BedrockAuthModeBearerToken {
			target.secretKeys[secretAuthorization] = credentialBearerToken
			auth.SecretRef = secretRef
			break
		}
		target.secretKeys[credentialAccessKey] = credentialAccessKey
		target.secretKeys[credentialSecretKey] = credentialSecretKey
		target.extractCredentials = true
		auth.AWS = &agentgatewayv1alpha1.AwsAuth{SecretRef: secretRef}
	case agentzv1alpha1.InferenceProviderKindAzure:
		azure := provider.Spec.Azure
		target.LLM.Azure = &agentgatewayv1alpha1.AzureConfig{
			Model:        modelRef,
			ResourceName: azure.ResourceName,
			ResourceType: agentgatewayv1alpha1.AzureResourceType(azure.ResourceType),
		}
		if azure.Project != "" {
			value := azure.Project
			target.LLM.Azure.ProjectName = &value
		}
		if azure.APIVersion != "" {
			value := azure.APIVersion
			target.LLM.Azure.ApiVersion = &value
		}
		switch azure.AuthMode {
		case agentzv1alpha1.AzureAuthModeAPIKey:
			target.secretKeys[secretAuthorization] = credentialAPIKey
			auth.SecretRef = secretRef
			auth.Location = headerLocation("api-key", "")
		default:
			target.secretKeys[credentialClientID] = credentialClientID
			target.secretKeys[credentialTenantID] = credentialTenantID
			target.secretKeys[credentialClientSecret] = credentialClientSecret
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
		target.LLM.Custom = &agentgatewayv1alpha1.CustomProvider{
			Model:   modelRef,
			Formats: formats,
		}
		err := applyEndpoint(
			&target.LLM, target.Policies, custom.BaseURL, custom.Path, custom.PathPrefix,
			custom.SkipTLSVerify,
		)
		if err != nil {
			return ProviderTarget{}, err
		}
		if custom.AuthMode == agentzv1alpha1.CompatibleProviderAuthModeAPIKey {
			target.secretKeys[secretAuthorization] = credentialAPIKey
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
			target.Policies.Transformation = &agentgatewayv1alpha1.Transformation{
				Request: &agentgatewayv1alpha1.Transform{Set: set},
			}
		}
	default:
		return ProviderTarget{}, fmt.Errorf("render unsupported provider kind %q", provider.Spec.Kind)
	}

	target.Policies.AI = &agentgatewayv1alpha1.BackendAI{
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
		target.Policies.Auth = auth
	}
	return target, nil
}

func applyEndpoint(llm *agentgatewayv1alpha1.LLMProvider, policies *agentgatewayv1alpha1.BackendWithAI, rawURL, path, pathPrefix string, skipTLSVerify bool) error {
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
	policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
	if skipTLSVerify {
		mode := agentgatewayv1alpha1.InsecureTLSModeAll
		policies.TLS.InsecureSkipVerify = &mode
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
