package inference

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	externalsecretsv1 "github.com/external-secrets/external-secrets/apis/externalsecrets/v1"
	"golang.org/x/oauth2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/oauth"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	// ProviderLabel identifies resources owned by an InferenceProvider.
	ProviderLabel = "agentz.accuknox.com/inference-provider"
	// ProviderKindLabel identifies the provider implementation of a resource.
	ProviderKindLabel = "agentz.accuknox.com/inference-provider-kind"
	credentialPathDir = "inference-providers"
	// SubscriptionCredentialPathDir isolates subscription tokens from API-key
	// credentials so extAuth can receive the narrowest possible OpenBao policy.
	SubscriptionCredentialPathDir = "inference-subscriptions"
	// OpenAICodexClientID is OpenAI's public Codex OAuth client identifier.
	OpenAICodexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	// OpenAICodexTokenEndpoint exchanges and refreshes Codex tokens.
	OpenAICodexTokenEndpoint = "https://auth.openai.com/oauth/token"
	// OpenAICodexModelsEndpoint serves the authenticated Codex model catalog.
	OpenAICodexModelsEndpoint = "https://chatgpt.com/backend-api/codex/models"
	// GitHubCopilotAPIEndpoint serves GitHub.com Copilot inference requests.
	GitHubCopilotAPIEndpoint = "https://api.githubcopilot.com"
	// GitHubCopilotAPIVersion is the API version used by the pinned OpenCode runtime.
	GitHubCopilotAPIVersion = "2026-06-01"

	secretAuthorization = "Authorization"
	secretCredentials   = "credentials.json"
)

// CredentialPath returns the OpenBao path for one provider's credential kind.
func CredentialPath(namespace, name string, kind agentzv1alpha1.InferenceProviderKind) string {
	dir := credentialPathDir
	isSubscription := kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
	isSubscription = isSubscription || kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
	if isSubscription {
		dir = SubscriptionCredentialPathDir
	}
	return namespace + "/" + dir + "/" + name
}

// SubscriptionRecord is the complete credential record retained only in
// OpenBao for a subscription-backed inference provider.
type SubscriptionRecord struct {
	Kind      agentzv1alpha1.InferenceProviderKind `json:"kind"`
	AccountID string                               `json:"accountId,omitempty"`
	ClientID  string                               `json:"clientId,omitempty"`
	Token     *oauth2.Token                        `json:"token"`
	Scopes    []string                             `json:"scopes,omitempty"`
	UpdatedAt time.Time                            `json:"updatedAt"`
}

// SubscriptionRecordData encodes a typed subscription record for OpenBao.
func SubscriptionRecordData(record SubscriptionRecord) (map[string]any, error) {
	payload, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("marshal inference subscription record: %w", err)
	}
	data := map[string]any{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, fmt.Errorf("encode inference subscription record: %w", err)
	}
	return data, nil
}

// DecodeSubscriptionRecord decodes one controlled OpenBao record strictly.
func DecodeSubscriptionRecord(data map[string]any) (SubscriptionRecord, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return SubscriptionRecord{}, fmt.Errorf("marshal inference subscription record: %w", err)
	}
	var record SubscriptionRecord
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&record); err != nil {
		return SubscriptionRecord{}, fmt.Errorf("decode inference subscription record: %w", err)
	}
	return record, nil
}

// RefreshSubscription returns a usable subscription record, refreshing Codex
// credentials when they are inside the shared expiry safety window.
func RefreshSubscription(ctx context.Context, client *http.Client, record SubscriptionRecord) (SubscriptionRecord, bool, error) {
	now := time.Now().UTC()
	if oauth.TokenUsable(record.Token, now) {
		return record, false, nil
	}
	if record.Kind != agentzv1alpha1.InferenceProviderKindOpenAICodex {
		return SubscriptionRecord{}, false, fmt.Errorf("subscription access token is unavailable")
	}
	token, scopes, err := oauth.Refresh(
		ctx,
		client,
		oauth.AuthConfig{
			TokenEndpoint:           OpenAICodexTokenEndpoint,
			TokenEndpointAuthMethod: "none",
		},
		oauth.Record{
			ClientID:  record.ClientID,
			Token:     record.Token,
			Scopes:    record.Scopes,
			UpdatedAt: record.UpdatedAt,
		},
	)
	if err != nil {
		return SubscriptionRecord{}, true, fmt.Errorf("refresh openai codex token: %w", err)
	}
	record.Token = token
	if len(scopes) > 0 {
		record.Scopes = scopes
	}
	record.UpdatedAt = now
	return record, true, nil
}

// Runtime contains the concrete resources for one provider. ExternalSecret is
// nil only for an explicitly unauthenticated OpenAI-compatible provider.
type Runtime struct {
	ExternalSecret *externalsecretsv1.ExternalSecret
	Backend        *agentgatewayv1alpha1.AgentgatewayBackend
	AuthPolicy     *agentgatewayv1alpha1.AgentgatewayPolicy
	SecretKeys     []string
}

// ProviderTarget contains one provider's complete member-scoped AgentGateway
// configuration. Model is empty for direct provider backends and set for Pool
// members so the logical Pool ID never reaches an upstream.
type ProviderTarget struct {
	LLM             agentgatewayv1alpha1.LLMProvider
	Policies        *agentgatewayv1alpha1.BackendWithAI
	AdditionalHosts []string

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
	hasTransportPolicy := target.Policies.TLS != nil || target.Policies.Auth != nil
	hasTransportPolicy = hasTransportPolicy || target.Policies.Transformation != nil
	if !hasTransportPolicy {
		backend.Spec.Policies = &agentgatewayv1alpha1.BackendFull{AI: target.Policies.AI}
	}
	if len(target.secretKeys) == 0 {
		runtime := Runtime{Backend: backend, SecretKeys: []string{}}
		isSubscription := provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
		isSubscription = isSubscription || provider.Spec.Kind == agentzv1alpha1.InferenceProviderKindGitHubCopilot
		if isSubscription {
			runtime.AuthPolicy = RenderInferenceAuthPolicy(
				provider.Namespace,
				provider.Name,
				nil,
				provider.Name,
				"",
			)
		}
		return runtime, nil
	}

	data := make([]externalsecretsv1.ExternalSecretData, 0, len(target.secretKeys))
	path := CredentialPath(provider.Namespace, provider.Name, provider.Spec.Kind)
	if !target.extractCredentials {
		for secretKey, property := range target.secretKeys {
			data = append(
				data,
				externalsecretsv1.ExternalSecretData{
					SecretKey: secretKey,
					RemoteRef: externalsecretsv1.ExternalSecretDataRemoteRef{
						Key:      path,
						Property: property,
					},
				},
			)
		}
	}
	slices.SortFunc(
		data,
		func(a, b externalsecretsv1.ExternalSecretData) int {
			return strings.Compare(a.SecretKey, b.SecretKey)
		},
	)
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

// RenderInferenceAuthPolicy applies fail-closed target authorization and
// credential injection to a direct provider or one named Pool member.
func RenderInferenceAuthPolicy(namespace, backend string, section *gwv1.SectionName, provider, pool string) *agentgatewayv1alpha1.AgentgatewayPolicy {
	identity := backend + "\x00" + provider
	if section != nil {
		identity += "\x00" + string(*section)
	}
	sum := sha256.Sum256([]byte(identity))
	name := fmt.Sprintf("inference-auth-%x", sum[:8])
	extAuthPort := mcp.ExtAuthPort
	contextExtensions := map[string]string{
		"agentz.namespace":          namespace,
		"agentz.inference_provider": provider,
	}
	if pool != "" {
		contextExtensions["agentz.inference_pool"] = pool
	}
	return &agentgatewayv1alpha1.AgentgatewayPolicy{
		TypeMeta: metav1.TypeMeta{
			APIVersion: agentgatewayv1alpha1.GroupVersion.String(),
			Kind:       "AgentgatewayPolicy",
		},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: agentgatewayv1alpha1.AgentgatewayPolicySpec{
			TargetRefs: []agentgatewayv1alpha1.LocalPolicyTargetReferenceWithSectionName{{
				LocalPolicyTargetReference: agentgatewayv1alpha1.LocalPolicyTargetReference{
					Group: "agentgateway.dev",
					Kind:  "AgentgatewayBackend",
					Name:  gwv1.ObjectName(backend),
				},
				SectionName: section,
			}},
			Backend: &agentgatewayv1alpha1.BackendFull{
				ExtAuth: &agentgatewayv1alpha1.ExtAuth{
					BackendRef: &gwv1.BackendObjectReference{
						Name: gwv1.ObjectName(mcp.ExtAuthServiceName),
						Port: &extAuthPort,
					},
					GRPC: &agentgatewayv1alpha1.AgentExtAuthGRPC{
						ContextExtensions: contextExtensions,
					},
				},
			},
		},
	}
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
	case agentzv1alpha1.InferenceProviderKindOpenAICodex:
		target.LLM.Custom = &agentgatewayv1alpha1.CustomProvider{
			Model: modelRef,
			Formats: []agentgatewayv1alpha1.ProviderFormatConfig{{
				Type: agentgatewayv1alpha1.ProviderFormatResponses,
				Path: "/backend-api/codex/responses",
			}},
		}
		err := applyEndpoint(
			&target.LLM,
			target.Policies,
			"https://chatgpt.com",
			"",
			"",
			false,
		)
		if err != nil {
			return ProviderTarget{}, err
		}
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		target.LLM.OpenAI = &agentgatewayv1alpha1.OpenAIConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		target.LLM.Host = "api.openai.com"
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
		if provider.Spec.OpenAI.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.OpenAI.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
		if target.LLM.PathPrefix == "" {
			target.LLM.PathPrefix = "/v1"
		}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		target.LLM.Anthropic = &agentgatewayv1alpha1.AnthropicConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-api-key", "")
		target.LLM.Host = "api.anthropic.com"
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
		if provider.Spec.Anthropic.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.Anthropic.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
		if target.LLM.PathPrefix == "" {
			target.LLM.PathPrefix = "/v1"
		}
	case agentzv1alpha1.InferenceProviderKindGemini:
		target.LLM.Gemini = &agentgatewayv1alpha1.GeminiConfig{Model: modelRef}
		target.secretKeys[secretAuthorization] = credentialAPIKey
		auth.SecretRef = secretRef
		auth.Location = headerLocation("x-goog-api-key", "")
		target.LLM.Host = "generativelanguage.googleapis.com"
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
		if provider.Spec.Gemini.BaseURL != "" {
			err := applyEndpoint(&target.LLM, target.Policies, provider.Spec.Gemini.BaseURL, "", "", false)
			if err != nil {
				return ProviderTarget{}, err
			}
		}
		if target.LLM.PathPrefix == "" {
			target.LLM.PathPrefix = "/"
		}
	case agentzv1alpha1.InferenceProviderKindGitHubCopilot:
		target.LLM.Custom = &agentgatewayv1alpha1.CustomProvider{
			Model: modelRef,
			Formats: []agentgatewayv1alpha1.ProviderFormatConfig{
				{Type: agentgatewayv1alpha1.ProviderFormatCompletions, Path: "/chat/completions"},
				{Type: agentgatewayv1alpha1.ProviderFormatResponses, Path: "/responses"},
				{Type: agentgatewayv1alpha1.ProviderFormatMessages, Path: "/v1/messages"},
			},
		}
		err := applyEndpoint(
			&target.LLM,
			target.Policies,
			GitHubCopilotAPIEndpoint,
			"",
			"",
			false,
		)
		if err != nil {
			return ProviderTarget{}, err
		}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		if modelRef != nil {
			value := vertexModelName(provider, *modelRef)
			modelRef = &value
		}
		target.LLM.VertexAI = &agentgatewayv1alpha1.VertexAIConfig{
			Model:     modelRef,
			ProjectId: provider.Spec.VertexAI.Project,
			Region:    provider.Spec.VertexAI.Region,
		}
		target.LLM.PathPrefix = "/"
		switch provider.Spec.VertexAI.Region {
		case "", "global":
			target.LLM.Host = "aiplatform.googleapis.com"
		case "us", "eu":
			target.LLM.Host = "aiplatform." + provider.Spec.VertexAI.Region +
				".rep.googleapis.com"
		default:
			target.LLM.Host = provider.Spec.VertexAI.Region +
				"-aiplatform.googleapis.com"
		}
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
		target.AdditionalHosts = []string{"discoveryengine.googleapis.com"}
		aliases := make(map[string]string)
		for _, model := range provider.Spec.Models {
			name := vertexModelName(provider, model.ID)
			if name != model.ID {
				aliases[model.ID] = name
			}
		}
		if len(aliases) > 0 {
			target.Policies.AI = &agentgatewayv1alpha1.BackendAI{
				ModelAliases: aliases,
			}
		}
		target.secretKeys[secretCredentials] = credentialServiceAccountJSON
		kind := agentgatewayv1alpha1.GcpAuthTypeAccessToken
		auth.GCP = &agentgatewayv1alpha1.GcpAuth{Type: &kind, SecretRef: secretRef}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		target.LLM.Bedrock = &agentgatewayv1alpha1.BedrockConfig{
			Region: provider.Spec.Bedrock.Region,
			Model:  modelRef,
		}
		target.LLM.PathPrefix = "/"
		target.LLM.Host = "bedrock-runtime." + provider.Spec.Bedrock.Region +
			".amazonaws.com"
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
		target.AdditionalHosts = []string{
			"bedrock-agent-runtime." + provider.Spec.Bedrock.Region +
				".amazonaws.com",
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
		target.LLM.PathPrefix = "/"
		target.LLM.Host = azure.ResourceName + ".openai.azure.com"
		if azure.ResourceType == agentzv1alpha1.AzureResourceTypeFoundry {
			target.LLM.Host = azure.ResourceName + ".services.ai.azure.com"
		}
		target.LLM.Port = 443
		target.Policies.TLS = &agentgatewayv1alpha1.BackendTLS{}
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
			&target.LLM,
			target.Policies,
			custom.BaseURL,
			custom.Path,
			custom.PathPrefix,
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
				set = append(
					set,
					agentgatewayv1alpha1.HeaderTransformation{
						Name:  agentgatewayv1alpha1.HeaderName(header.Name),
						Value: agentgatewayv1alpha1.CELExpression(strconv.Quote(header.Value)),
					},
				)
			}
			target.Policies.Transformation = &agentgatewayv1alpha1.Transformation{
				Request: &agentgatewayv1alpha1.Transform{Set: set},
			}
		}
	default:
		return ProviderTarget{}, fmt.Errorf("render unsupported provider kind %q", provider.Spec.Kind)
	}

	if target.Policies.AI == nil {
		target.Policies.AI = &agentgatewayv1alpha1.BackendAI{}
	}
	target.Policies.AI.Routes = map[string]agentgatewayv1alpha1.RouteType{
		"/chat/completions":      agentgatewayv1alpha1.RouteTypeCompletions,
		"/embeddings":            agentgatewayv1alpha1.RouteTypeEmbeddings,
		"/messages":              agentgatewayv1alpha1.RouteTypeMessages,
		"/messages/count_tokens": agentgatewayv1alpha1.RouteTypeAnthropicTokenCount,
		"/models":                agentgatewayv1alpha1.RouteTypeModels,
		"/realtime":              agentgatewayv1alpha1.RouteTypeRealtime,
		"/responses":             agentgatewayv1alpha1.RouteTypeResponses,
	}
	if auth.SecretRef != nil || auth.AWS != nil || auth.Azure != nil || auth.GCP != nil {
		target.Policies.Auth = auth
	}
	return target, nil
}

func vertexModelName(provider *agentzv1alpha1.InferenceProvider, model string) string {
	isVertex := provider.Spec.CatalogProvider == "google-vertex"
	isQualified := strings.Contains(model, "/") || strings.HasPrefix(model, "claude-")
	if !isVertex || isQualified {
		return model
	}
	return "google/" + model
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
		policies.TLS = nil
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
