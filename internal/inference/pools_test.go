package inference

import (
	"context"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type resolvePoolInvalidMembershipCase struct {
	name    string
	members []agentzv1alpha1.InferencePoolMember
	field   string
}

type poolHealthCase struct {
	code      int
	unhealthy bool
}

func TestResolvePoolContract(t *testing.T) {
	t.Parallel()

	input := int32(64000)
	primary := poolProvider("openai", agentzv1alpha1.InferenceProviderKindOpenAI)
	primary.Spec.Models[0].Capabilities = agentzv1alpha1.InferenceModelCapabilities{
		Attachment:  true,
		Reasoning:   true,
		Temperature: true,
		ToolCall:    true,
	}
	primary.Spec.Models[0].Modalities.Input = []agentzv1alpha1.InferenceModelModality{
		agentzv1alpha1.InferenceModelModalityText,
		agentzv1alpha1.InferenceModelModalityImage,
		agentzv1alpha1.InferenceModelModalityAudio,
	}
	primary.Spec.Models[0].Modalities.Output = []agentzv1alpha1.InferenceModelModality{
		agentzv1alpha1.InferenceModelModalityText,
		agentzv1alpha1.InferenceModelModalityAudio,
	}
	primary.Spec.Models[0].Limits = agentzv1alpha1.InferenceModelLimits{
		Context: 128000,
		Output:  8192,
	}
	secondary := poolProvider("anthropic", agentzv1alpha1.InferenceProviderKindAnthropic)
	secondary.Spec.Models[0].Capabilities = agentzv1alpha1.InferenceModelCapabilities{
		Attachment:  true,
		Temperature: true,
		ToolCall:    true,
	}
	secondary.Spec.Models[0].Modalities.Input = []agentzv1alpha1.InferenceModelModality{
		agentzv1alpha1.InferenceModelModalityImage,
		agentzv1alpha1.InferenceModelModalityText,
	}
	secondary.Spec.Models[0].Modalities.Output = []agentzv1alpha1.InferenceModelModality{
		agentzv1alpha1.InferenceModelModalityText,
	}
	secondary.Spec.Models[0].Limits = agentzv1alpha1.InferenceModelLimits{
		Context: 100000,
		Input:   &input,
		Output:  4096,
	}

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	reader := poolTestReader(t, scheme, primary, secondary)
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool", Namespace: "default"},
		Spec: agentzv1alpha1.InferencePoolSpec{
			Members: []agentzv1alpha1.InferencePoolMember{
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: primary.Name,
					Model:    "model",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: secondary.Name,
					Model:    "model",
				},
			},
		},
	}
	definition, issues, err := ResolvePool(context.Background(), reader, pool)
	if err != nil {
		t.Fatalf("ResolvePool() error = %v", err)
	}
	if len(issues) > 0 {
		t.Fatalf("ResolvePool() issues = %v", issues)
	}
	if definition.Protocol != agentzv1alpha1.InferenceProtocolOpenAI {
		t.Fatalf("protocol = %q, want OpenAI", definition.Protocol)
	}
	if definition.Contract.API != agentzv1alpha1.InferenceModelAPIChatCompletions {
		t.Fatalf("API = %q, want ChatCompletions", definition.Contract.API)
	}
	if len(definition.Warnings) != 1 {
		t.Fatalf("warnings = %#v, want one mixed-protocol warning", definition.Warnings)
	}
	if definition.Warnings[0].Code != agentzv1alpha1.InferencePoolWarningMixedProtocols {
		t.Fatalf("warnings = %#v, want one mixed-protocol warning", definition.Warnings)
	}
	wantCapabilities := agentzv1alpha1.InferenceModelCapabilities{
		Attachment:  true,
		Temperature: true,
		ToolCall:    true,
	}
	if !reflect.DeepEqual(definition.Contract.Capabilities, wantCapabilities) {
		t.Fatalf("capabilities = %#v, want %#v", definition.Contract.Capabilities, wantCapabilities)
	}
	wantInput := []agentzv1alpha1.InferenceModelModality{
		agentzv1alpha1.InferenceModelModalityText,
		agentzv1alpha1.InferenceModelModalityImage,
	}
	if !reflect.DeepEqual(definition.Contract.Modalities.Input, wantInput) {
		t.Fatalf("input modalities = %#v, want %#v", definition.Contract.Modalities.Input, wantInput)
	}
	limits := definition.Contract.Limits
	wrongInput := limits.Input == nil || *limits.Input != 64000
	if limits.Context != 100000 || wrongInput || limits.Output != 4096 {
		t.Fatalf("limits = %#v, want context=100000 input=64000 output=4096", definition.Contract.Limits)
	}
}

func TestResolvePoolRejectsUnsupportedAPIConversion(t *testing.T) {
	t.Parallel()

	primary := poolProvider("primary", agentzv1alpha1.InferenceProviderKindOpenAI)
	secondary := poolProvider("secondary", agentzv1alpha1.InferenceProviderKindOpenAICodex)
	api := agentzv1alpha1.InferenceModelAPIResponses
	secondary.Spec.Models[0].API = &api

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	reader := poolTestReader(t, scheme, primary, secondary)
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool", Namespace: "default"},
		Spec: agentzv1alpha1.InferencePoolSpec{
			Members: []agentzv1alpha1.InferencePoolMember{
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: primary.Name,
					Model:    "model",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: secondary.Name,
					Model:    "model",
				},
			},
		},
	}
	_, issues, err := ResolvePool(context.Background(), reader, pool)
	if err != nil {
		t.Fatalf("ResolvePool() error = %v", err)
	}
	message := "These models cannot be used together. " +
		"Choose a different model combination."
	validIssue := len(issues) == 1 && issues[0].Field == "members.1.model"
	if !validIssue || issues[0].Message != message {
		t.Fatalf("ResolvePool() issues = %#v, want unsupported members issue", issues)
	}
}

func TestResolvePoolRejectsInvalidMembership(t *testing.T) {
	t.Parallel()

	provider := poolProvider("provider", agentzv1alpha1.InferenceProviderKindOpenAI)
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	tests := []resolvePoolInvalidMembershipCase{
		{name: "empty", field: "members"},
		{
			name: "unavailable workspace scope",
			members: []agentzv1alpha1.InferencePoolMember{{
				Scope:    agentzv1alpha1.ResourceScopeWorkspace,
				Provider: "provider",
				Model:    "model",
			}},
			field: "members.0.scope",
		},
		{
			name: "too many",
			members: []agentzv1alpha1.InferencePoolMember{
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "1",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "2",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "3",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "4",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "5",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "6",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "7",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "8",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "9",
				},
			},
			field: "members",
		},
		{
			name: "duplicate",
			members: []agentzv1alpha1.InferencePoolMember{
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "model",
				},
				{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: "provider",
					Model:    "model",
				},
			},
			field: "members.1",
		},
		{
			name: "missing provider",
			members: []agentzv1alpha1.InferencePoolMember{{
				Scope:    agentzv1alpha1.ResourceScopeOrganisation,
				Provider: "missing",
				Model:    "model",
			}},
			field: "members.0.provider",
		},
		{
			name: "missing model",
			members: []agentzv1alpha1.InferencePoolMember{{
				Scope:    agentzv1alpha1.ResourceScopeOrganisation,
				Provider: "provider",
				Model:    "missing",
			}},
			field: "members.0.model",
		},
	}
	for _, test := range tests {
		t.Run(
			test.name,
			func(t *testing.T) {
				reader := poolTestReader(t, scheme, provider.DeepCopy())
				pool := &agentzv1alpha1.InferencePool{
					ObjectMeta: metav1.ObjectMeta{Name: "pool", Namespace: "default"},
					Spec:       agentzv1alpha1.InferencePoolSpec{Members: test.members},
				}
				_, issues, err := ResolvePool(context.Background(), reader, pool)
				if err != nil {
					t.Fatalf("ResolvePool() error = %v", err)
				}
				if len(issues) == 0 || issues[0].Field != test.field {
					t.Fatalf("ResolvePool() issues = %#v, want first field %q", issues, test.field)
				}
			},
		)
	}
}

func TestRenderPoolBackend(t *testing.T) {
	t.Parallel()

	primary := poolProvider("primary", agentzv1alpha1.InferenceProviderKindOpenAI)
	secondary := poolProvider("secondary", agentzv1alpha1.InferenceProviderKindAnthropic)
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "logical", Namespace: "default"},
		Spec:       agentzv1alpha1.InferencePoolSpec{AutomaticFailover: true},
	}
	definition := PoolDefinition{
		Members: []ResolvedPoolMember{
			{
				Ref: agentzv1alpha1.InferencePoolMember{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: primary.Name,
					Model:    "gpt",
				},
				Provider: primary,
			},
			{
				Ref: agentzv1alpha1.InferencePoolMember{
					Scope:    agentzv1alpha1.ResourceScopeOrganisation,
					Provider: secondary.Name,
					Model:    "claude",
				},
				Provider: secondary,
			},
		},
	}
	backend, err := RenderPoolBackend(pool, definition)
	if err != nil {
		t.Fatalf("RenderPoolBackend() error = %v", err)
	}
	groups := backend.Spec.AI.PriorityGroups
	if len(groups) != 2 || len(groups[0].Providers) != 1 || len(groups[1].Providers) != 1 {
		t.Fatalf("priority groups = %#v, want two one-provider groups", groups)
	}
	openAI := groups[0].Providers[0].OpenAI
	if openAI == nil || openAI.Model == nil {
		t.Fatalf("primary model override = %#v, want gpt", openAI)
	}
	if *openAI.Model != "gpt" {
		t.Fatalf("primary model override = %#v, want gpt", groups[0].Providers[0].OpenAI)
	}
	auth := groups[0].Providers[0].Policies.Auth
	if auth == nil || auth.SecretRef == nil || string(auth.SecretRef.Name) != "logical-primary" {
		t.Fatalf("primary credential projection = %#v, want logical-primary", auth)
	}
	if auth.SecretRef.Key != nil {
		t.Fatalf("primary credential key = %q, want Agentgateway default", *auth.SecretRef.Key)
	}
	anthropic := groups[1].Providers[0].Anthropic
	if anthropic == nil || anthropic.Model == nil {
		t.Fatalf("secondary model override = %#v, want claude", anthropic)
	}
	if *anthropic.Model != "claude" {
		t.Fatalf("secondary model override = %#v, want claude", groups[1].Providers[0].Anthropic)
	}
	env, err := cel.NewEnv(cel.Variable("response", cel.DynType))
	if err != nil {
		t.Fatal(err)
	}
	responses := []poolHealthCase{
		{code: 0, unhealthy: true},
		{code: 200, unhealthy: false},
		{code: 400, unhealthy: false},
		{code: 401, unhealthy: true},
		{code: 403, unhealthy: true},
		{code: 404, unhealthy: false},
		{code: 429, unhealthy: true},
		{code: 500, unhealthy: true},
		{code: 503, unhealthy: true},
	}
	for i := range groups {
		health := groups[i].Providers[0].Policies.Health
		if health == nil || health.UnhealthyCondition == nil || health.Eviction == nil {
			t.Fatalf("group %d health = %#v", i, health)
		}
		expression, issues := env.Compile(string(*health.UnhealthyCondition))
		if issues.Err() != nil {
			t.Fatal(issues.Err())
		}
		program, err := env.Program(expression)
		if err != nil {
			t.Fatal(err)
		}
		for _, response := range responses {
			t.Run(strconv.Itoa(i)+"/"+strconv.Itoa(response.code), func(t *testing.T) {
				var input any
				if response.code != 0 {
					input = map[string]any{"code": response.code}
				}
				got, _, err := program.Eval(map[string]any{"response": input})
				if err != nil || got != types.Bool(response.unhealthy) {
					t.Fatalf("health condition = %v, %v; want %v", got, err, response.unhealthy)
				}
			})
		}
		eviction := health.Eviction
		missingSettings := eviction.Duration == nil ||
			eviction.ConsecutiveFailures == nil ||
			eviction.RestoreHealth == nil
		if missingSettings {
			t.Fatalf("group %d eviction = %#v", i, eviction)
		}
		durationMismatch := eviction.Duration.Duration != 60*time.Second
		failuresMismatch := *eviction.ConsecutiveFailures != 1
		restoreMismatch := *eviction.RestoreHealth != 100
		if durationMismatch || failuresMismatch || restoreMismatch {
			t.Fatalf("group %d eviction = %#v", i, health.Eviction)
		}
	}
	again, err := RenderPoolBackend(pool, definition)
	if err != nil {
		t.Fatal(err)
	}
	if groups[0].Providers[0].Name != again.Spec.AI.PriorityGroups[0].Providers[0].Name {
		t.Fatal("member names are not deterministic")
	}

	pool.Spec.AutomaticFailover = false
	backend, err = RenderPoolBackend(pool, definition)
	if err != nil {
		t.Fatal(err)
	}
	for i, group := range backend.Spec.AI.PriorityGroups {
		if group.Providers[0].Policies.Health != nil {
			t.Fatalf("group %d rendered health with failover disabled", i)
		}
	}
}

func poolProvider(name string, kind agentzv1alpha1.InferenceProviderKind) *agentzv1alpha1.InferenceProvider {
	return &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec:       providerSpec(kind),
	}
}

func poolTestReader(t testing.TB, scheme *runtime.Scheme, providers ...*agentzv1alpha1.InferenceProvider) client.Reader {
	t.Helper()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := make([]client.Object, 0, len(providers)+1)
	objects = append(
		objects,
		&corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: "default",
				Labels: map[string]string{
					agentzv1alpha1.TenantNameLabel: "default",
				},
			},
		},
	)
	for _, provider := range providers {
		objects = append(objects, provider)
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()
}
