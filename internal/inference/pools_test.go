package inference

import (
	"context"
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type resolvePoolInvalidMembershipCase struct {
	name      string
	members   []agentzv1alpha1.InferencePoolMember
	configure func()
	field     string
}

func TestResolvePoolContract(t *testing.T) {
	t.Parallel()

	input := int32(64000)
	primary := poolProvider("openai", agentzv1alpha1.InferenceProviderKindOpenAI)
	primary.Spec.Models[0].Capabilities = agentzv1alpha1.InferenceModelCapabilities{
		Attachment: true, Reasoning: true, Temperature: true, ToolCall: true,
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
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: primary.Name, Model: "model"},
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: secondary.Name, Model: "model"},
		}},
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
	if definition.Contract.Limits.Context != 100000 || definition.Contract.Limits.Input == nil || *definition.Contract.Limits.Input != 64000 || definition.Contract.Limits.Output != 4096 {
		t.Fatalf("limits = %#v, want context=100000 input=64000 output=4096", definition.Contract.Limits)
	}
}

func TestResolvePoolResponsesAPI(t *testing.T) {
	t.Parallel()

	primary := poolProvider("primary", agentzv1alpha1.InferenceProviderKindOpenAICodex)
	secondary := poolProvider("secondary", agentzv1alpha1.InferenceProviderKindOpenAICodex)
	api := agentzv1alpha1.InferenceModelAPIResponses
	primary.Spec.Models[0].API = &api
	secondary.Spec.Models[0].API = &api

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	reader := poolTestReader(t, scheme, primary, secondary)
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "pool", Namespace: "default"},
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: primary.Name, Model: "model"},
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: secondary.Name, Model: "model"},
		}},
	}
	definition, issues, err := ResolvePool(context.Background(), reader, pool)
	if err != nil {
		t.Fatalf("ResolvePool() error = %v", err)
	}
	if len(issues) > 0 {
		t.Fatalf("ResolvePool() issues = %v", issues)
	}
	if definition.Contract.API != agentzv1alpha1.InferenceModelAPIResponses {
		t.Fatalf("API = %q, want Responses", definition.Contract.API)
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
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: primary.Name, Model: "model"},
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: secondary.Name, Model: "model"},
		}},
	}
	_, issues, err := ResolvePool(context.Background(), reader, pool)
	if err != nil {
		t.Fatalf("ResolvePool() error = %v", err)
	}
	if len(issues) != 1 || issues[0].Field != "members.1.model" || issues[0].Message != "These models cannot be used together. Choose a different model combination." {
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
			name:    "unavailable workspace scope",
			members: []agentzv1alpha1.InferencePoolMember{{Scope: agentzv1alpha1.ResourceScopeWorkspace, Provider: "provider", Model: "model"}},
			field:   "members.0.scope",
		},
		{
			name: "too many",
			members: []agentzv1alpha1.InferencePoolMember{
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "1"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "2"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "3"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "4"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "5"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "6"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "7"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "8"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "9"},
			},
			field: "members",
		},
		{
			name: "duplicate",
			members: []agentzv1alpha1.InferencePoolMember{
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "model"},
				{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "model"},
			},
			field: "members.1",
		},
		{
			name:    "missing provider",
			members: []agentzv1alpha1.InferencePoolMember{{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "missing", Model: "model"}},
			field:   "members.0.provider",
		},
		{
			name:    "missing model",
			members: []agentzv1alpha1.InferencePoolMember{{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "missing"}},
			field:   "members.0.model",
		},
		{
			name:    "missing text output",
			members: []agentzv1alpha1.InferencePoolMember{{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "model"}},
			configure: func() {
				provider.Spec.Models[0].Modalities.Output = []agentzv1alpha1.InferenceModelModality{
					agentzv1alpha1.InferenceModelModalityAudio,
				}
			},
			field: "members.0.model",
		},
	}
	for _, test := range tests {
		t.Run(
			test.name,
			func(t *testing.T) {
				if test.configure != nil {
					test.configure()
				}
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
	definition := PoolDefinition{Members: []ResolvedPoolMember{
		{
			Ref:      agentzv1alpha1.InferencePoolMember{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: primary.Name, Model: "gpt"},
			Provider: primary,
		},
		{
			Ref:      agentzv1alpha1.InferencePoolMember{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: secondary.Name, Model: "claude"},
			Provider: secondary,
		},
	}}
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
	anthropic := groups[1].Providers[0].Anthropic
	if anthropic == nil || anthropic.Model == nil {
		t.Fatalf("secondary model override = %#v, want claude", anthropic)
	}
	if *anthropic.Model != "claude" {
		t.Fatalf("secondary model override = %#v, want claude", groups[1].Providers[0].Anthropic)
	}
	for i := range groups {
		health := groups[i].Providers[0].Policies.Health
		if health == nil || health.UnhealthyCondition == nil || health.Eviction == nil {
			t.Fatalf("group %d health = %#v", i, health)
		}
		wantCondition := "response == null || response.code == 401 || response.code == 403 || response.code == 429 || response.code >= 500"
		if string(*health.UnhealthyCondition) != wantCondition {
			t.Fatalf("group %d unhealthy condition = %q", i, *health.UnhealthyCondition)
		}
		eviction := health.Eviction
		if eviction.Duration == nil || eviction.ConsecutiveFailures == nil || eviction.RestoreHealth == nil {
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

func TestRenderSandboxPoolTarget(t *testing.T) {
	t.Parallel()

	runtime := RenderSandboxTarget(
		"default",
		"sandbox",
		SandboxTarget{
			Name: "pool", Backend: "pool", Path: SandboxPoolPath("sandbox", "pool"),
			Models: []string{"pool"}, Labels: map[string]string{PoolLabel: "pool"},
			Retries: 1,
		},
	)
	match := runtime.Route.Spec.Rules[0].Matches[0].Path
	if match == nil || match.Value == nil || *match.Value != "/sandboxes/sandbox/pools/pool" {
		t.Fatalf("route path = %#v", match)
	}
	if len(runtime.Route.Spec.Rules[0].Filters) != 0 {
		t.Fatalf("route filters = %#v, want none", runtime.Route.Spec.Rules[0].Filters)
	}
	expressions := runtime.Policy.Spec.Traffic.Authorization.Policy.MatchExpressions
	if len(expressions) != 1 {
		t.Fatalf("authorization expressions = %#v", expressions)
	}
	wantExpression := "default(json(request.body).model, \"\") in [\"pool\"]"
	if string(expressions[0]) != wantExpression {
		t.Fatalf("authorization expressions = %#v", expressions)
	}
	retry := runtime.Policy.Spec.Traffic.Retry
	if retry == nil || retry.Attempts == nil || retry.Backoff == nil || retry.Condition == nil {
		t.Fatalf("retry = %#v", retry)
	}
	attemptsMismatch := *retry.Attempts != 1
	backoffMismatch := *retry.Backoff != "50ms"
	wantRetryCondition := "response.code == 401 || response.code == 403 || response.code == 429 || response.code >= 500"
	if attemptsMismatch || backoffMismatch || string(*retry.Condition) != wantRetryCondition {
		t.Fatalf("retry = %#v", retry)
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
