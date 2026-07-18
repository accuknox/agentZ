package inference

import (
	"testing"

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
			spec:  providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAI),
			valid: true,
		},
		{
			name: "valid custom authorization header",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthMode = agentzv1alpha1.OpenAICompatibleAuthModeAPIKey
				spec.OpenAICompatible.AuthHeader = "authorization"
				spec.OpenAICompatible.AuthPrefix = "Bearer "
				return spec
			}(),
			valid: true,
		},
		{
			name: "mismatched configuration arm",
			spec: agentzv1alpha1.InferenceProviderSpec{
				DisplayName: "OpenAI",
				Type:        agentzv1alpha1.InferenceProviderTypeOpenAI,
				Anthropic:   &agentzv1alpha1.AnthropicProviderConfig{},
				Models:      providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAI).Models,
			},
		},
		{
			name: "custom http without explicit exception",
			spec: providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible),
		},
		{
			name: "custom credential header",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
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
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthMode = agentzv1alpha1.OpenAICompatibleAuthModeAPIKey
				spec.OpenAICompatible.AuthHeader = "host"
				return spec
			}(),
		},
		{
			name: "custom authentication settings without authentication",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				spec.OpenAICompatible.AuthPrefix = "Bearer "
				return spec
			}(),
		},
		{
			name: "custom header value containing a line break",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
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
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAICompatible)
				spec.OpenAICompatible.BaseURL = "http://127.0.0.1:65536/v1"
				spec.OpenAICompatible.AllowPrivateEndpoint = true
				return spec
			}(),
		},
		{
			name: "invalid bedrock region",
			spec: func() agentzv1alpha1.InferenceProviderSpec {
				spec := providerSpec(agentzv1alpha1.InferenceProviderTypeBedrock)
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

	openAI := providerSpec(agentzv1alpha1.InferenceProviderTypeOpenAI)
	if _, err := CredentialsForCreate(openAI, CredentialValues{}); err == nil {
		t.Fatal("CredentialsForCreate() unexpectedly accepted a blank API key")
	}

	bedrock := providerSpec(agentzv1alpha1.InferenceProviderTypeBedrock)
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
}

func providerSpec(providerType agentzv1alpha1.InferenceProviderType) agentzv1alpha1.InferenceProviderSpec {
	spec := agentzv1alpha1.InferenceProviderSpec{
		DisplayName: "Provider",
		Type:        providerType,
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

	switch providerType {
	case agentzv1alpha1.InferenceProviderTypeOpenAI:
		spec.OpenAI = &agentzv1alpha1.OpenAIProviderConfig{}
	case agentzv1alpha1.InferenceProviderTypeAnthropic:
		spec.Anthropic = &agentzv1alpha1.AnthropicProviderConfig{}
	case agentzv1alpha1.InferenceProviderTypeGemini:
		spec.Gemini = &agentzv1alpha1.GeminiProviderConfig{}
	case agentzv1alpha1.InferenceProviderTypeVertexAI:
		spec.VertexAI = &agentzv1alpha1.VertexAIProviderConfig{Project: "project", Region: "us-central1"}
	case agentzv1alpha1.InferenceProviderTypeBedrock:
		spec.Bedrock = &agentzv1alpha1.BedrockProviderConfig{Region: "us-east-1"}
	case agentzv1alpha1.InferenceProviderTypeAzure:
		spec.Azure = &agentzv1alpha1.AzureProviderConfig{
			ResourceType: agentzv1alpha1.AzureResourceTypeOpenAI,
			ResourceName: "resource",
			APIVersion:   "v1",
			AuthMode:     agentzv1alpha1.AzureAuthModeAPIKey,
		}
	case agentzv1alpha1.InferenceProviderTypeOpenAICompatible:
		spec.OpenAICompatible = &agentzv1alpha1.OpenAICompatibleProviderConfig{
			BaseURL:  "http://127.0.0.1:18080/v1",
			AuthMode: agentzv1alpha1.OpenAICompatibleAuthModeNone,
		}
	}
	return spec
}
