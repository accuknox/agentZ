package inference

import (
	"context"
	"testing"
	"time"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestValidateProvider(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		spec  agentzv1alpha1.InferenceProviderSpec
		valid bool
	}{
		{
			name:  "valid openai",
			spec:  providerSpec(agentzv1alpha1.InferenceProviderKindOpenAI),
			valid: true,
		},
		{
			name: "valid custom authorization header",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthMode = agentzv1alpha1.CompatibleProviderAuthModeAPIKey
				spec.OpenAICompatible.AuthHeader = "authorization"
				spec.OpenAICompatible.AuthPrefix = "Bearer "
				return spec
			}(),
			valid: true,
		},
		{
			name:  "valid anthropic-compatible provider",
			spec:  providerSpec(agentzv1alpha1.InferenceProviderKindAnthropicCompatible),
			valid: true,
		},
		{
			name: "mismatched configuration arm",
			spec: agentzv1alpha1.InferenceProviderSpec{
				DisplayName: "OpenAI",
				Kind:        agentzv1alpha1.InferenceProviderKindOpenAI,
				Anthropic:   &agentzv1alpha1.AnthropicProviderConfig{},
				Models:      providerSpec(agentzv1alpha1.InferenceProviderKindOpenAI).Models,
			},
		},
		{
			name: "custom http without explicit exception",
			spec: providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible),
		},
		{
			name: "custom credential header",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.Headers = []agentzv1alpha1.InferenceProviderHeader{{
					Name: "x-api-key", Value: "not-secret",
				}}
				return spec
			}(),
		},
		{
			name: "custom forbidden authentication header",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthMode = agentzv1alpha1.CompatibleProviderAuthModeAPIKey
				spec.OpenAICompatible.AuthHeader = "host"
				return spec
			}(),
		},
		{
			name: "custom authentication settings without authentication",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthPrefix = "Bearer "
				return spec
			}(),
		},
		{
			name: "custom header value containing a line break",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.Headers = []agentzv1alpha1.InferenceProviderHeader{{
					Name: "x-environment", Value: "safe\r\nforwarded: injected",
				}}
				return spec
			}(),
		},
		{
			name: "endpoint port outside valid range",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAICompatible)
				spec.OpenAICompatible.BaseURL = "http://127.0.0.1:65536/v1"
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				return spec
			}(),
		},
		{
			name: "invalid bedrock region",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderKindBedrock)
				spec.Bedrock.Region = "us-east"
				return spec
			}(),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			issues := ValidateProvider(test.spec)
			if test.valid && len(issues) > 0 {
				t.Fatalf("ValidateProvider() issues = %v", issues)
			}
			if !test.valid && len(issues) == 0 {
				t.Fatal("ValidateProvider() unexpectedly succeeded")
			}
		})
	}
}

func TestCredentials(t *testing.T) {
	t.Parallel()

	openAI := providerSpec(agentzv1alpha1.InferenceProviderKindOpenAI)
	if _, err := CredentialsForCreate(openAI, CredentialValues{}); err == nil {
		t.Fatal("CredentialsForCreate() unexpectedly accepted a blank API key")
	}

	bedrock := providerSpec(agentzv1alpha1.InferenceProviderKindBedrock)
	_, _, err := CredentialsForUpdate(bedrock, CredentialValues{AccessKey: "new"})
	if err == nil {
		t.Fatal("CredentialsForUpdate() unexpectedly accepted partial AWS credentials")
	}
	record, changed, err := CredentialsForUpdate(bedrock, CredentialValues{
		AccessKey: "access", SecretKey: "secret",
	})
	if err != nil || !changed {
		t.Fatalf("CredentialsForUpdate() error = %v, changed = %t", err, changed)
	}
	if _, exists := record[credentialSessionToken]; exists {
		t.Fatal("CredentialsForUpdate() materialized an empty AWS session token")
	}

	record, changed, err = CredentialsForUpdate(openAI, CredentialValues{})
	if err != nil {
		t.Fatalf("CredentialsForUpdate() error = %v", err)
	}
	if changed || record != nil {
		t.Fatalf("CredentialsForUpdate() = %#v, %t; want nil, false", record, changed)
	}

	bedrock.Bedrock.AuthMode = agentzv1alpha1.BedrockAuthModeBearerToken
	record, changed, err = CredentialsForUpdate(bedrock, CredentialValues{
		BearerToken: "token",
	})
	if err != nil || !changed || record[credentialBearerToken] != "token" {
		t.Fatalf("CredentialsForUpdate() = %#v, %t, %v", record, changed, err)
	}
	_, _, err = CredentialsForUpdate(bedrock, CredentialValues{
		AccessKey: "access", SecretKey: "secret",
	})
	if err == nil {
		t.Fatal("CredentialsForUpdate() accepted access keys in bearer-token mode")
	}
}

func TestRenderRuntimeCompatibleFormats(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		kind     agentzv1alpha1.InferenceProviderKind
		expected []agentgatewayv1alpha1.ProviderFormat
	}{
		{
			name:     "openai compatible",
			kind:     agentzv1alpha1.InferenceProviderKindOpenAICompatible,
			expected: []agentgatewayv1alpha1.ProviderFormat{agentgatewayv1alpha1.ProviderFormatCompletions},
		},
		{
			name: "anthropic compatible",
			kind: agentzv1alpha1.InferenceProviderKindAnthropicCompatible,
			expected: []agentgatewayv1alpha1.ProviderFormat{
				agentgatewayv1alpha1.ProviderFormatMessages,
				agentgatewayv1alpha1.ProviderFormatAnthropicTokenCount,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			provider := &agentzv1alpha1.InferenceProvider{
				ObjectMeta: metav1.ObjectMeta{Name: "provider", Namespace: "default"},
				Spec:       providerSpec(test.kind),
			}
			runtime, err := RenderRuntime(provider, "openbao", time.Hour)
			if err != nil {
				t.Fatalf("RenderRuntime() error = %v", err)
			}
			formats := runtime.Backend.Spec.AI.LLM.Custom.Formats
			if len(formats) != len(test.expected) {
				t.Fatalf("RenderRuntime() formats = %#v, want %#v", formats, test.expected)
			}
			for i, expected := range test.expected {
				if formats[i].Type != expected {
					t.Fatalf("RenderRuntime() format %d = %q, want %q", i, formats[i].Type, expected)
				}
			}
		})
	}
}

func TestRenderProviderTargetVertexModelNames(t *testing.T) {
	t.Parallel()

	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "vertex", Namespace: "default"},
		Spec:       providerSpec(agentzv1alpha1.InferenceProviderKindVertexAI),
	}
	provider.Spec.Models[0].ID = "gemini-2.5-flash"
	provider.Spec.Models = append(provider.Spec.Models, agentzv1alpha1.InferenceModel{
		ID: "claude-haiku-4-5@20251001",
	})

	direct, err := RenderProviderTarget(provider, "")
	if err != nil {
		t.Fatalf("RenderProviderTarget() direct error = %v", err)
	}
	got := direct.Policies.AI.ModelAliases["gemini-2.5-flash"]
	if got != "google/gemini-2.5-flash" {
		t.Fatalf(
			"RenderProviderTarget() direct alias = %q, want google/gemini-2.5-flash",
			got,
		)
	}
	if _, ok := direct.Policies.AI.ModelAliases["claude-haiku-4-5@20251001"]; ok {
		t.Fatal("RenderProviderTarget() aliases the native Vertex Claude model")
	}

	pool, err := RenderProviderTarget(provider, "gemini-2.5-flash")
	if err != nil {
		t.Fatalf("RenderProviderTarget() pool error = %v", err)
	}
	if pool.LLM.VertexAI.Model == nil {
		t.Fatal("RenderProviderTarget() pool model is nil")
	}
	if *pool.LLM.VertexAI.Model != "google/gemini-2.5-flash" {
		t.Fatalf(
			"RenderProviderTarget() pool model = %v, want google/gemini-2.5-flash",
			pool.LLM.VertexAI.Model,
		)
	}

	pool, err = RenderProviderTarget(provider, "claude-haiku-4-5@20251001")
	if err != nil {
		t.Fatalf("RenderProviderTarget() Claude pool error = %v", err)
	}
	if pool.LLM.VertexAI.Model == nil {
		t.Fatal("RenderProviderTarget() Claude pool model is nil")
	}
	if *pool.LLM.VertexAI.Model != "claude-haiku-4-5@20251001" {
		t.Fatalf(
			"RenderProviderTarget() Claude pool model = %v, want claude-haiku-4-5@20251001",
			pool.LLM.VertexAI.Model,
		)
	}
}

func TestValidateModelRemovalRejectsPoolReference(t *testing.T) {
	t.Parallel()

	current := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "provider", Namespace: "default"},
		Spec:       providerSpec(agentzv1alpha1.InferenceProviderKindOpenAI),
	}
	desired := current.DeepCopy()
	desired.Spec.Models = nil
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool", Namespace: "default"},
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{{
			Provider: current.Name, Model: "model",
		}}},
	}
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pool).WithIndex(
		&agentzv1alpha1.InferencePool{}, PoolByProviderIndex,
		func(obj client.Object) []string {
			value := obj.(*agentzv1alpha1.InferencePool)
			providers := make([]string, 0, len(value.Spec.Members))
			for _, member := range value.Spec.Members {
				providers = append(providers, member.Provider)
			}
			return providers
		},
	).Build()
	issues, err := ValidateModelRemoval(context.Background(), reader, current, desired)
	if err != nil {
		t.Fatalf("ValidateModelRemoval() error = %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("ValidateModelRemoval() issues = %#v", issues)
	}
	fieldMismatch := issues[0].Field != "models"
	messageMismatch := issues[0].Message != "model \"model\" is referenced by pools [pool]"
	if fieldMismatch || messageMismatch {
		t.Fatalf("ValidateModelRemoval() issues = %#v", issues)
	}
}

func providerSpec(providerKind agentzv1alpha1.InferenceProviderKind) agentzv1alpha1.InferenceProviderSpec {
	spec := agentzv1alpha1.InferenceProviderSpec{
		DisplayName: "Provider",
		Kind:        providerKind,
		Models: []agentzv1alpha1.InferenceModel{{
			ID:           "model",
			DisplayName:  "Model",
			Capabilities: agentzv1alpha1.InferenceModelCapabilities{ToolCall: true},
			Modalities: agentzv1alpha1.InferenceModelModalities{
				Input:  []agentzv1alpha1.InferenceModelModality{agentzv1alpha1.InferenceModelModalityText},
				Output: []agentzv1alpha1.InferenceModelModality{agentzv1alpha1.InferenceModelModalityText},
			},
			Limits: agentzv1alpha1.InferenceModelLimits{Context: 128000, Output: 4096},
		}},
	}

	switch providerKind {
	case agentzv1alpha1.InferenceProviderKindOpenAI:
		spec.CatalogProvider = "openai"
		spec.OpenAI = &agentzv1alpha1.OpenAIProviderConfig{}
	case agentzv1alpha1.InferenceProviderKindAnthropic:
		spec.CatalogProvider = "anthropic"
		spec.Anthropic = &agentzv1alpha1.AnthropicProviderConfig{}
	case agentzv1alpha1.InferenceProviderKindGemini:
		spec.CatalogProvider = "google"
		spec.Gemini = &agentzv1alpha1.GeminiProviderConfig{}
	case agentzv1alpha1.InferenceProviderKindVertexAI:
		spec.CatalogProvider = "google-vertex"
		spec.VertexAI = &agentzv1alpha1.VertexAIProviderConfig{Project: "project", Region: "us-central1"}
	case agentzv1alpha1.InferenceProviderKindBedrock:
		spec.CatalogProvider = "amazon-bedrock"
		spec.Bedrock = &agentzv1alpha1.BedrockProviderConfig{
			Region: "us-east-1", AuthMode: agentzv1alpha1.BedrockAuthModeAccessKey,
		}
	case agentzv1alpha1.InferenceProviderKindAzure:
		spec.CatalogProvider = "azure"
		spec.Azure = &agentzv1alpha1.AzureProviderConfig{
			ResourceType: agentzv1alpha1.AzureResourceTypeOpenAI,
			ResourceName: "resource",
			APIVersion:   "v1",
			AuthMode:     agentzv1alpha1.AzureAuthModeAPIKey,
		}
	case agentzv1alpha1.InferenceProviderKindOpenAICompatible:
		spec.CatalogProvider = "custom"
		spec.OpenAICompatible = &agentzv1alpha1.CompatibleProviderConfig{
			BaseURL:  "http://127.0.0.1:18080/v1",
			AuthMode: agentzv1alpha1.CompatibleProviderAuthModeNone,
		}
	case agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		spec.CatalogProvider = "custom"
		spec.AnthropicCompatible = &agentzv1alpha1.CompatibleProviderConfig{
			BaseURL:              "http://127.0.0.1:18080/v1",
			AuthMode:             agentzv1alpha1.CompatibleProviderAuthModeNone,
			AllowPrivateEndpoint: true,
		}
	}
	for i := range spec.Models {
		spec.Models[i].Catalog = &agentzv1alpha1.InferenceModelCatalog{
			Provider: spec.CatalogProvider,
		}
	}
	return spec
}
