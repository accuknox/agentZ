package guardrails

import (
	"strconv"
	"strings"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func guardrailFixture(t *testing.T) (client.Client, string, string) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := api.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	org := api.ScopeNamespace(api.ResourceScopeOrganisation, "organization")
	workspace := api.ScopeNamespace(api.ResourceScopeWorkspace, "workspace")
	objects := []client.Object{
		&corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name:   org,
				Labels: map[string]string{api.TenantNameLabel: org},
			},
		},
		&corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: workspace,
				Labels: map[string]string{
					api.WorkspaceNameLabel:        workspace,
					api.TenantOrganizationIDLabel: org,
				},
			},
		},
		&api.Workspace{
			ObjectMeta: metav1.ObjectMeta{Name: workspace},
			Spec:       api.WorkspaceSpec{WorkspaceID: "workspace", OrganizationID: "organization"},
		},
		&api.Tenant{
			ObjectMeta: metav1.ObjectMeta{Name: org},
			Spec: api.TenantSpec{
				OrganizationID: "organization",
				Guardrails: api.GuardrailSettings{
					MandatoryPolicies: []string{"baseline"},
				},
			},
		},
		&api.GuardrailPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "baseline",
				Namespace:  org,
				UID:        "baseline-id",
				Generation: 1,
			},
			Spec: api.GuardrailPolicySpec{
				DisplayName: "Organization baseline",
				Checks: []api.GuardrailCheck{
					{
						ID:          "mandatory",
						Name:        "Mandatory detector",
						Phase:       "input",
						Scopes:      []string{"instructions", "conversation"},
						Mode:        "enforce",
						FailureMode: "closed",
						Action:      "deny",
						Regex:       &api.GuardrailRegex{Patterns: []string{"forbidden"}},
					},
				},
			},
		},
		&api.GuardrailPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "addition",
				Namespace:  workspace,
				UID:        "addition-id",
				Generation: 1,
			},
			Spec: api.GuardrailPolicySpec{
				DisplayName: "Workspace addition",
				Checks: []api.GuardrailCheck{
					{
						ID:          "optional",
						Name:        "Optional detector",
						Phase:       "input",
						Scopes:      []string{"conversation"},
						Mode:        "audit",
						FailureMode: "open",
						Action:      "deny",
						Regex:       &api.GuardrailRegex{Patterns: []string{"sensitive"}},
					},
				},
			},
		},
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build(), org, workspace
}

func TestMandatoryPolicyCannotBeReorderedOrWeakenedByAssignments(t *testing.T) {
	reader, _, workspace := guardrailFixture(t)
	assignment := api.GuardrailAssignment{
		Policies: []api.ResourceReference{
			{Scope: api.ResourceScopeWorkspace, Name: "addition"},
			{Scope: api.ResourceScopeOrganisation, Name: "baseline"},
		},
	}
	bundle, err := Resolve(t.Context(), reader, workspace, assignment)
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Checks) != 2 || bundle.Checks[0].Check.ID != "mandatory" || !bundle.Checks[0].Mandatory {
		t.Fatalf("mandatory baseline lost precedence after optional policy promotion: %#v", bundle.Checks)
	}
	if bundle.Checks[0].Check.Mode != "enforce" || bundle.Checks[0].Check.FailureMode != "closed" {
		t.Fatal("workspace policy weakened organization enforcement")
	}
	if *bundle.Guard.Request[0].Regex.Action != agw.REJECT || *bundle.Guard.Request[1].Regex.Action != agw.AUDIT {
		t.Fatal("baseline and workspace enforcement modes were combined incorrectly")
	}

}

func TestOptionalOrganizationPoliciesRequireExplicitSelection(t *testing.T) {
	reader, org, workspace := guardrailFixture(t)
	policy := &api.GuardrailPolicy{}
	err := reader.Get(t.Context(), client.ObjectKey{Namespace: org, Name: "baseline"}, policy)
	if err != nil {
		t.Fatal(err)
	}
	policy.ResourceVersion = ""
	policy.Name = "unselected"
	policy.UID = "unselected-id"
	if err := reader.Create(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	assignment := api.GuardrailAssignment{
		Policies: []api.ResourceReference{
			{Scope: api.ResourceScopeOrganisation, Name: "unselected"},
		},
	}
	_, err = Resolve(t.Context(), reader, workspace, assignment)
	if err == nil || !strings.Contains(err.Error(), "not selected") {
		t.Fatalf("unselected organization policy was available: %v", err)
	}
	if _, err := Resolve(t.Context(), reader, workspace, api.GuardrailAssignment{}); err != nil {
		t.Fatalf("mandatory baseline incorrectly required optional selection: %v", err)
	}
}

func TestRevisionExcludesStatusAndPreservesInflightSnapshot(t *testing.T) {
	reader, org, workspace := guardrailFixture(t)
	first, err := Resolve(t.Context(), reader, workspace, api.GuardrailAssignment{})
	if err != nil {
		t.Fatal(err)
	}
	policy := &api.GuardrailPolicy{}
	key := client.ObjectKey{Namespace: org, Name: "baseline"}
	if err := reader.Get(t.Context(), key, policy); err != nil {
		t.Fatal(err)
	}
	policy.Status.Message = "Reconciliation updated status"
	if err := reader.Update(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	statusOnly, err := Resolve(t.Context(), reader, workspace, api.GuardrailAssignment{})
	if err != nil || statusOnly.Revision != first.Revision {
		t.Fatalf("observed status changed desired policy revision: %v", err)
	}
	policy.Spec.Checks[0].Regex.Patterns = []string{"stricter"}
	policy.Generation++
	if err := reader.Update(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	updated, err := Resolve(t.Context(), reader, workspace, api.GuardrailAssignment{})
	if err != nil || updated.Revision == first.Revision {
		t.Fatalf("policy edit failed to change effective revision: %v", err)
	}
	if first.Guard.Request[0].Regex.Matches[0] != "forbidden" {
		t.Fatal("resolving a later request mutated an inflight policy snapshot")
	}
}

func TestCombinedPolicyLimitFailsWithoutDroppingMandatoryChecks(t *testing.T) {
	reader, _, workspace := guardrailFixture(t)
	policy := &api.GuardrailPolicy{}
	err := reader.Get(t.Context(), client.ObjectKey{Namespace: workspace, Name: "addition"}, policy)
	if err != nil {
		t.Fatal(err)
	}
	first := policy.Spec.Checks[0]
	policy.Spec.Checks = nil
	for _, id := range []string{"one", "two", "three", "four", "five", "six", "seven", "eight"} {
		check := first
		check.ID = id
		policy.Spec.Checks = append(policy.Spec.Checks, check)
	}
	if err := reader.Update(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	assignment := api.GuardrailAssignment{
		Policies: []api.ResourceReference{{Scope: api.ResourceScopeWorkspace, Name: "addition"}},
	}
	_, err = Resolve(t.Context(), reader, workspace, assignment)
	if err == nil || !strings.Contains(err.Error(), "eight checks") {
		t.Fatalf("over-limit composition silently omitted safeguards: %v", err)
	}
}

func TestRemoteProviderMaskingCannotBeOverriddenByAnUnusedAction(t *testing.T) {
	policy := api.GuardrailPolicySpec{
		DisplayName: "Remote detector",
		Checks: []api.GuardrailCheck{{
			ID:          "remote",
			Name:        "Remote detector",
			Phase:       "input",
			Scopes:      []string{"instructions", "conversation"},
			Mode:        "enforce",
			FailureMode: "closed",
			Action:      "mask",
			Connection:  &api.ResourceReference{Scope: api.ResourceScopeWorkspace, Name: "detector"},
		}},
	}
	if err := ValidatePolicy(policy); err == nil {
		t.Fatal("a remote mask override was silently accepted even though native providers own the resulting action")
	}
	policy.Checks[0].Action = "deny"
	if err := ValidatePolicy(policy); err != nil {
		t.Fatalf("normal native-provider enforcement was rejected: %v", err)
	}
}

func TestCompilePolicySharesConnectionsAndRejectsTermination(t *testing.T) {
	reader, _, namespace := guardrailFixture(t)
	connection := &api.GuardrailConnection{
		ObjectMeta: metav1.ObjectMeta{
			Namespace:  namespace,
			Name:       "detector",
			Finalizers: []string{api.GuardrailConnectionFinalizer},
		},
		Spec: api.GuardrailConnectionSpec{
			DisplayName: "Detector",
			Provider:    "Webhook",
			Endpoint:    "https://detector.example",
		},
	}
	if err := reader.Create(t.Context(), connection); err != nil {
		t.Fatal(err)
	}
	policy := &api.GuardrailPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: "shared"},
		Spec:       api.GuardrailPolicySpec{DisplayName: "Shared detector"},
	}
	for _, id := range []string{"first", "second"} {
		policy.Spec.Checks = append(policy.Spec.Checks, api.GuardrailCheck{
			ID:          id,
			Name:        id,
			Phase:       "input",
			Mode:        "enforce",
			Action:      "deny",
			FailureMode: "closed",
			Scopes:      []string{"instructions", "conversation"},
			Connection:  &api.ResourceReference{Scope: api.ResourceScopeWorkspace, Name: connection.Name},
		})
	}
	bundle, err := CompilePolicy(t.Context(), reader, namespace, policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Connections) != 1 || len(bundle.Guard.Request) != 2 {
		t.Fatal("shared connections must project once without dropping ordered checks")
	}
	if err := reader.Delete(t.Context(), connection); err != nil {
		t.Fatal(err)
	}
	_, err = CompilePolicy(t.Context(), reader, namespace, policy)
	if err == nil || !strings.Contains(err.Error(), "terminating") {
		t.Fatalf("terminating detector was accepted: %v", err)
	}
}

func TestMandatoryChecksRejectOptionalMutations(t *testing.T) {
	for _, provider := range []api.GuardrailProvider{"Regex", "Webhook", "Bedrock", "ModelArmor"} {
		for _, mode := range []string{"enforce", "audit"} {
			for _, phase := range []string{"input", "output"} {
				t.Run(string(provider)+"/"+mode+"/"+phase, func(t *testing.T) {
					mandatory := ResolvedCheck{
						Mandatory: true,
						Check: api.GuardrailCheck{
							ID:     "mandatory",
							Name:   "Mandatory",
							Phase:  "input",
							Mode:   "enforce",
							Action: "deny",
							Scopes: []string{"instructions", "conversation"},
							Regex:  &api.GuardrailRegex{Patterns: []string{"secret"}},
						},
					}
					optional := ResolvedCheck{
						Check: api.GuardrailCheck{
							ID:               "optional",
							Name:             "Optional",
							Phase:            phase,
							Mode:             mode,
							Action:           "deny",
							Scopes:           []string{"instructions", "conversation"},
							GuardrailID:      "id",
							GuardrailVersion: "1",
							Template:         "projects/project/locations/region/templates/template",
						},
					}
					if phase == "output" {
						optional.Check.Scopes = []string{"conversation"}
					}
					switch provider {
					case "Regex":
						optional.Check.Action = "mask"
						optional.Check.Regex = &api.GuardrailRegex{Patterns: []string{"secret"}}
					default:
						optional.Connection = &api.GuardrailConnection{
							Spec: api.GuardrailConnectionSpec{Provider: provider, Region: "region"},
						}
					}
					bundle := &Bundle{Checks: []ResolvedCheck{mandatory, optional}}
					err := bundle.compile("namespace")
					wantError := phase == "input" && mode == "enforce" && provider != "ModelArmor"
					if (err != nil) != wantError {
						t.Fatalf("optional mutation validation = %v, want error %v", err, wantError)
					}
				})
			}
		}
	}
}

func TestProviderRequestScopes(t *testing.T) {
	for _, provider := range []api.GuardrailProvider{"OpenAI", "Bedrock", "ModelArmor", "Webhook"} {
		t.Run(string(provider), func(t *testing.T) {
			check := api.GuardrailCheck{
				ID:               "scoped",
				Name:             "Scoped check",
				Phase:            "input",
				Scopes:           []string{"toolResults"},
				Mode:             "enforce",
				FailureMode:      "closed",
				Action:           "deny",
				GuardrailID:      "guardrail",
				GuardrailVersion: "1",
				Template:         "projects/project/locations/region/templates/template",
			}
			bundle := &Bundle{Checks: []ResolvedCheck{{
				Check: check,
				Connection: &api.GuardrailConnection{
					Spec: api.GuardrailConnectionSpec{Provider: provider},
				},
			}}}
			err := bundle.compile("namespace")
			if provider != "Bedrock" {
				if err == nil {
					t.Fatal("provider accepted scopes the pinned integration cannot enforce")
				}
				bundle.Checks[0].Check.Scopes = []string{"instructions", "conversation"}
				if err := bundle.compile("namespace"); err != nil {
					t.Fatalf("default request scopes rejected: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("supported request scope rejected: %v", err)
			}
			scopes := bundle.Guard.Request[0].Scope
			if len(scopes) != 1 || scopes[0] != agw.ContentScopeToolOutput {
				t.Fatalf("request scope was not preserved: %v", scopes)
			}
		})
	}
}

func TestStreamingRegexNeedsBoundedContext(t *testing.T) {
	for _, pattern := range []string{"SECRET", "[0-9]{3}", "^SECRET", "SECRET$", "a+", "a{257}", `\bsecret\b`} {
		t.Run(pattern, func(t *testing.T) {
			check := api.GuardrailCheck{
				ID:          "check",
				Name:        "Output check",
				Phase:       "output",
				Scopes:      []string{"conversation"},
				FailureMode: "closed",
				Mode:        "enforce",
				Action:      "deny",
				Regex:       &api.GuardrailRegex{Patterns: []string{pattern}},
			}
			policy := api.GuardrailPolicySpec{DisplayName: "Output policy", Checks: []api.GuardrailCheck{check}}
			wantError := pattern != "SECRET" && pattern != "[0-9]{3}"
			if err := ValidatePolicy(policy); (err != nil) != wantError {
				t.Fatalf("stream validation = %v, want error %v", err, wantError)
			}
			policy.Checks[0].Mode = "audit"
			if err := ValidatePolicy(policy); err != nil {
				t.Fatalf("audit check rejected: %v", err)
			}
			policy.Checks[0].Mode = "enforce"
			policy.Checks[0].Action = "mask"
			if err := ValidatePolicy(policy); err != nil {
				t.Fatalf("response masking policy rejected: %v", err)
			}
		})
	}
}

func TestPolicyChangesValidateAffectedEffectiveConfiguration(t *testing.T) {
	reader, org, workspace := guardrailFixture(t)
	assignment := api.GuardrailAssignment{
		Policies: []api.ResourceReference{{Scope: api.ResourceScopeWorkspace, Name: "addition"}},
	}
	keys := []client.ObjectKey{
		{Namespace: org, Name: "baseline"},
		{Namespace: workspace, Name: "addition"},
	}
	for _, key := range keys {
		proposed := &api.GuardrailPolicy{}
		if err := reader.Get(t.Context(), key, proposed); err != nil {
			t.Fatal(err)
		}
		check := proposed.Spec.Checks[0]
		for i := 1; i < 8; i++ {
			extra := check
			extra.ID = strconv.Itoa(i)
			proposed.Spec.Checks = append(proposed.Spec.Checks, extra)
		}
		if _, err := CompilePolicy(t.Context(), reader, proposed.Namespace, proposed); err != nil {
			t.Fatalf("individual policy must be valid: %v", err)
		}
		settings := api.GuardrailSettings{MandatoryPolicies: []string{"baseline"}}
		err := ValidateConfiguration(t.Context(), reader, workspace, settings, assignment, proposed)
		if err == nil || !strings.Contains(err.Error(), "eight") {
			t.Fatalf("expected combined check limit, got %v", err)
		}
		current := &api.GuardrailPolicy{}
		if err := reader.Get(t.Context(), key, current); err != nil {
			t.Fatal(err)
		}
		if len(current.Spec.Checks) != 1 {
			t.Fatal("validation changed the active policy")
		}
	}
}

func TestSettingsChangesIncludeExistingOptionalAssignments(t *testing.T) {
	reader, org, workspace := guardrailFixture(t)
	original := &api.GuardrailPolicy{}
	key := client.ObjectKey{Namespace: org, Name: "baseline"}
	err := reader.Get(t.Context(), key, original)
	if err != nil {
		t.Fatal(err)
	}
	proposed := &api.GuardrailPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: org, Name: "new-baseline"},
		Spec:       original.Spec,
	}
	for i := 1; i < 8; i++ {
		check := original.Spec.Checks[0]
		check.ID = strconv.Itoa(i)
		proposed.Spec.Checks = append(proposed.Spec.Checks, check)
	}
	if err := reader.Create(t.Context(), proposed); err != nil {
		t.Fatal(err)
	}
	settings := api.GuardrailSettings{MandatoryPolicies: []string{"new-baseline"}}
	err = ValidateConfiguration(t.Context(), reader, org, settings, api.GuardrailAssignment{}, nil)
	if err != nil {
		t.Fatalf("proposed baseline alone must be valid: %v", err)
	}
	assignment := api.GuardrailAssignment{
		Policies: []api.ResourceReference{{Scope: api.ResourceScopeWorkspace, Name: "addition"}},
	}
	err = ValidateConfiguration(t.Context(), reader, workspace, settings, assignment, nil)
	if err == nil || !strings.Contains(err.Error(), "eight") {
		t.Fatalf("proposed settings must include the existing assignment: %v", err)
	}
}
