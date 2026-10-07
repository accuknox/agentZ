package inference

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type validateProviderCase struct {
	name  string
	spec  agentzv1alpha1.InferenceProviderSpec
	valid bool
}

func TestValidateProvider(t *testing.T) {
	t.Parallel()

	tests := []validateProviderCase{
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
		t.Run(
			test.name,
			func(t *testing.T) {
				t.Parallel()
				issues := ValidateProvider(test.spec)
				if test.valid && len(issues) > 0 {
					t.Fatalf("ValidateProvider() issues = %v", issues)
				}
				if !test.valid && len(issues) == 0 {
					t.Fatal("ValidateProvider() unexpectedly succeeded")
				}
			},
		)
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
	record, changed, err := CredentialsForUpdate(
		bedrock,
		CredentialValues{
			AccessKey: "access", SecretKey: "secret",
		},
	)
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
	record, changed, err = CredentialsForUpdate(
		bedrock,
		CredentialValues{
			BearerToken: "token",
		},
	)
	if err != nil || !changed || record[credentialBearerToken] != "token" {
		t.Fatalf("CredentialsForUpdate() = %#v, %t, %v", record, changed, err)
	}
	_, _, err = CredentialsForUpdate(
		bedrock,
		CredentialValues{
			AccessKey: "access", SecretKey: "secret",
		},
	)
	if err == nil {
		t.Fatal("CredentialsForUpdate() accepted access keys in bearer-token mode")
	}
}

func TestRenderProviderTargetVertexModelNames(t *testing.T) {
	t.Parallel()

	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "vertex", Namespace: "default"},
		Spec:       providerSpec(agentzv1alpha1.InferenceProviderKindVertexAI),
	}
	provider.Spec.Models[0].ID = "gemini-2.5-flash"
	provider.Spec.Models = append(
		provider.Spec.Models,
		agentzv1alpha1.InferenceModel{
			ID: "claude-haiku-4-5@20251001",
		},
	)

	direct, err := RenderProviderTarget(provider, "")
	if err != nil {
		t.Fatalf("RenderProviderTarget() direct error = %v", err)
	}
	if direct.LLM.VertexAI.ProjectId != "project" || direct.LLM.VertexAI.Region != "us-central1" {
		t.Fatalf("RenderProviderTarget() Vertex settings = %#v", direct.LLM.VertexAI)
	}
	auth := direct.Policies.Auth
	if auth == nil || auth.GCP == nil || auth.GCP.SecretRef == nil {
		t.Fatalf("RenderProviderTarget() auth = %#v", direct.Policies.Auth)
	}
	ref := auth.GCP.SecretRef
	if ref.Name != "vertex" || ref.Key != nil {
		t.Fatalf("RenderProviderTarget() auth = %#v", direct.Policies.Auth)
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
			Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: current.Name, Model: "model",
		}}},
	}
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pool).WithIndex(
		&agentzv1alpha1.InferencePool{},
		PoolByProviderIndex,
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

type delegationInferenceCase struct {
	name, body string
	responses  bool
	allowed    bool
}

func TestDelegatedInferenceRejectsProviderResourceBypasses(t *testing.T) {
	for _, test := range []delegationInferenceCase{
		{"chat", `{"model":"selected","messages":[{"role":"user","content":"hi"}]}`, false, true},
		{"responses", `{"model":"selected","store":false,"input":"hi"}`, true, true},
		{"explicit previous message", `{"model":"selected","store":false,"input":[{"type":"message","id":"msg-inline","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`, true, true},
		{"implicit item reference", `{"model":"selected","store":false,"input":[{"id":"msg-private"}]}`, true, false},
		{"case sensitive implicit reference", `{"model":"selected","store":false,"input":[{"id":"msg-private","ID":""}]}`, true, false},
		{"inline audio", `{"model":"selected","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"YQ==","format":"wav"}}]}],"audio":{"voice":"alloy","format":"wav"}}`, false, true},
		{"hosted chat search", `{"model":"selected","web_search_options":{}}`, false, false},
		{"case sensitive hosted search", `{"model":"selected","web_search_options":{},"WEB_SEARCH_OPTIONS":null}`, false, false},
		{"stored chat audio", `{"model":"selected","messages":[{"role":"assistant","audio":{"id":"audio-private"}}]}`, false, false},
		{"case sensitive stored audio", `{"model":"selected","messages":[{"role":"assistant","audio":{"id":"audio-private"},"AUDIO":null}]}`, false, false},
		{"inline function file", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_file","file_data":"data:application/pdf;base64,YQ=="}]}]}`, true, true},
		{"case sensitive store", `{"model":"selected","store":true,"STORE":false}`, false, false},
		{"case sensitive background", `{"model":"selected","store":false,"background":true,"BACKGROUND":false}`, true, false},
		{"duplicate store", `{"model":"selected","store":true,"store":false}`, false, false},
		{"escaped duplicate store", `{"model":"selected","store":true,"\u0073tore":false}`, false, false},
		{"case sensitive hosted tool", `{"model":"selected","tools":[{"type":"file_search","TYPE":"function"}]}`, false, false},
		{"chat unrelated input", `{"model":"selected","messages":[{"content":[{"type":"file","file":{"file_id":"file-private"}}]}],"input":[]}`, false, false},
		{"case sensitive message content", `{"model":"selected","messages":[{"content":[{"file":{"file_id":"file-private","FILE_ID":""}}],"CONTENT":"ignored"}]}`, false, false},
		{"duplicate nested file", `{"model":"selected","messages":[{"content":[{"file":{"file_id":"file-private","file_id":""}}]}]}`, false, false},
		{"duplicate response content", `{"model":"selected","store":false,"input":[{"content":[{"file_id":"file-private"}],"content":[]}]}`, true, false},
		{"response function file", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_file","file_id":"file-private"}]}]}`, true, false},
		{"response function image", `{"model":"selected","store":false,"input":[{"type":"function_call_output","call_id":"call","output":[{"type":"input_image","file_id":"file-private"}]}]}`, true, false},
		{"response screenshot", `{"model":"selected","store":false,"input":[{"type":"computer_call_output","output":{"type":"computer_screenshot","file_id":"file-private"}}]}`, true, false},
		{"case sensitive reference", `{"model":"selected","store":false,"input":[{"type":"item_reference","TYPE":"message","id":"msg-private"}]}`, true, false},
		{"duplicate response input", `{"model":"selected","store":false,"input":[{"type":"item_reference","id":"msg-private"}],"input":[]}`, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			model, err := ValidateDelegatedRequest([]byte(test.body), test.responses)
			if (err == nil) != test.allowed {
				t.Fatalf("allowed %v, want %v: %v", err == nil, test.allowed, err)
			}
			if test.allowed && model != "selected" {
				t.Fatalf("model %q", model)
			}
		})
	}
}
