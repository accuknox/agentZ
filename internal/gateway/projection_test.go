package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	"github.com/jackc/pgx/v5/pgtype"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/inference"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type guardrailProjectionClient struct {
	ctrlclient.Client
}

// Patch emulates server-side apply for the fake Kubernetes client.
func (c *guardrailProjectionClient) Patch(ctx context.Context, object ctrlclient.Object, patch ctrlclient.Patch, options ...ctrlclient.PatchOption) error {
	if patch.Type() != types.ApplyPatchType {
		return c.Client.Patch(ctx, object, patch, options...)
	}
	// The fake client does not implement SSA. Keep the rendered objects, while
	// rejecting the missing GVK that a real API server also rejects for apply.
	if object.GetObjectKind().GroupVersionKind().Empty() {
		return errors.New("apply object has no apiVersion/kind")
	}
	return c.Create(ctx, object)
}

func TestDelegatedGuardrailProjectionTargetsItsRouteAndGatesReadiness(t *testing.T) {
	queries := &delegationQueries{}
	service := sandboxTestService(t, queries)
	scheme := service.k8sClient.Scheme()
	if err := agw.Install(scheme); err != nil {
		t.Fatal(err)
	}
	if err := gwv1.Install(scheme); err != nil {
		t.Fatal(err)
	}
	if err := ciliumv2.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	service.k8sClient = &guardrailProjectionClient{Client: service.k8sClient}
	service.cfg.DelegationNamespace = "private"
	service.cfg.GatewayServiceAccountNamespace = "default"
	org := api.ScopeNamespace(api.ResourceScopeOrganisation, testOrganizationID)
	workspace := api.ScopeNamespace(api.ResourceScopeWorkspace, testWorkspaceID)
	tenant := &api.Tenant{}
	if err := service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Name: org}, tenant); err != nil {
		t.Fatal(err)
	}
	tenant.Spec.Guardrails.MandatoryPolicies = []string{"baseline"}
	if err := service.k8sClient.Update(t.Context(), tenant); err != nil {
		t.Fatal(err)
	}
	provider := &api.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "provider", Namespace: workspace, UID: "provider-id"},
		Spec: api.InferenceProviderSpec{
			Kind:   api.InferenceProviderKindOpenAI,
			OpenAI: &api.OpenAIProviderConfig{},
			Models: []api.InferenceModel{{ID: "model"}},
		},
	}
	objects := []ctrlclient.Object{
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
			Spec: api.WorkspaceSpec{
				WorkspaceID:    testWorkspaceID,
				OrganizationID: testOrganizationID,
			},
		},
		&api.GuardrailPolicy{
			ObjectMeta: metav1.ObjectMeta{
				Name:       "baseline",
				Namespace:  org,
				UID:        "policy-id",
				Generation: 1,
			},
			Spec: api.GuardrailPolicySpec{
				DisplayName: "Baseline",
				Checks: []api.GuardrailCheck{
					{
						ID:          "deny",
						Name:        "Baseline detector",
						Phase:       "input",
						Scopes:      []string{"conversation"},
						Mode:        "enforce",
						FailureMode: "closed",
						Action:      "deny",
						Regex:       &api.GuardrailRegex{Patterns: []string{"forbidden"}},
					},
				},
			},
		},
		provider,
	}
	for _, object := range objects {
		if err := service.k8sClient.Create(t.Context(), object); err != nil {
			t.Fatal(err)
		}
	}
	selection := gatewayapi.DelegationCatalog{
		Models: []gatewayapi.DelegationModel{
			{
				Id:          "model-id",
				Model:       "model",
				Namespace:   workspace,
				Provider:    provider.Name,
				Uid:         string(provider.UID),
				WorkspaceId: testWorkspaceID,
			},
		},
	}
	encoded, err := json.Marshal(selection)
	if err != nil {
		t.Fatal(err)
	}
	grant := gatewaydb.DelegationGrant{
		ID:             "guarded-grant",
		ClientID:       "client",
		OrganizationID: pgtype.Text{String: testOrganizationID, Valid: true},
		Selection:      encoded,
	}
	resources := &delegationResources{
		providers: map[ctrlclient.ObjectKey]*api.InferenceProvider{
			{Namespace: workspace, Name: provider.Name}: provider,
		},
	}
	err = service.projectDelegation(t.Context(), grant, "Test app", "application", selection, resources)
	if err != nil {
		t.Fatal(err)
	}
	name := "d-guarded-grant-model-0"
	guard := &agw.AgentgatewayPolicy{}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: workspace, Name: name + "-guardrails"}, guard)
	if err != nil {
		t.Fatal(err)
	}
	if len(guard.Spec.TargetRefs) != 1 || guard.Spec.TargetRefs[0].Name != gwv1.ObjectName(name) {
		t.Fatalf("guardrail policy does not target the actual inference route: %#v", guard.Spec.TargetRefs)
	}
	if guard.Spec.Backend == nil || guard.Spec.Backend.AI == nil || len(guard.Spec.Backend.AI.PromptGuard.Request) != 1 {
		t.Fatal("mandatory baseline did not reach delegated inference")
	}
	if guard.Spec.Traffic != nil {
		t.Fatal("guardrail policy competes with the route's audit metadata transformation")
	}
	telemetry := &agw.AgentgatewayPolicy{}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: workspace, Name: name + "-telemetry"}, telemetry)
	if err != nil {
		t.Fatal(err)
	}
	metadata := telemetry.Spec.Traffic.Transformation.Request.Metadata
	if metadata["agentz_guardrail_revision"] == "" || metadata["agentz_observability"] == "" {
		t.Fatal("one route transformation must retain both guardrail revision and audit attribution")
	}
	conditions := []metav1.Condition{
		{Type: "Accepted", Status: metav1.ConditionTrue},
		{Type: "Attached", Status: metav1.ConditionTrue},
		{Type: "ResolvedRefs", Status: metav1.ConditionTrue},
	}
	route := &gwv1.HTTPRoute{}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: workspace, Name: name}, route)
	if err != nil {
		t.Fatal(err)
	}
	route.Status.Parents = []gwv1.RouteParentStatus{
		{
			ParentRef:      gwv1.ParentReference{Name: inference.GatewayName},
			ControllerName: "agentgateway.dev/agentgateway",
			Conditions:     conditions,
		},
	}
	if err := service.k8sClient.Update(t.Context(), route); err != nil {
		t.Fatal(err)
	}
	backend := &agw.AgentgatewayBackend{}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: workspace, Name: name}, backend)
	if err != nil {
		t.Fatal(err)
	}
	backend.Status.Conditions = conditions
	if err := service.k8sClient.Update(t.Context(), backend); err != nil {
		t.Fatal(err)
	}
	for _, policyName := range []string{name + "-telemetry", "inference-delegation-tracing"} {
		policy := &agw.AgentgatewayPolicy{}
		key := ctrlclient.ObjectKey{Namespace: workspace, Name: policyName}
		if err := service.k8sClient.Get(t.Context(), key, policy); err != nil {
			policy.Name, policy.Namespace = policyName, workspace
			if err := service.k8sClient.Create(t.Context(), policy); err != nil {
				t.Fatal(err)
			}
		}
		policy.Status.Ancestors = []gwv1.PolicyAncestorStatus{
			{
				AncestorRef:    gwv1.ParentReference{Name: inference.GatewayName},
				ControllerName: "agentgateway.dev/agentgateway",
				Conditions:     conditions,
			},
		}
		if err := service.k8sClient.Update(t.Context(), policy); err != nil {
			t.Fatal(err)
		}
	}
	err = service.delegationReady(t.Context(), grant, workspace, inference.GatewayName, name, name+"-telemetry")
	if err == nil {
		t.Fatal("inference became ready before the mandatory guardrail policy was attached")
	}
	guard.Status.Ancestors = []gwv1.PolicyAncestorStatus{
		{
			AncestorRef:    gwv1.ParentReference{Name: inference.GatewayName},
			ControllerName: "agentgateway.dev/agentgateway",
			Conditions:     conditions,
		},
	}
	if err := service.k8sClient.Update(t.Context(), guard); err != nil {
		t.Fatal(err)
	}
	err = service.delegationReady(t.Context(), grant, workspace, inference.GatewayName, name, name+"-telemetry")
	if err != nil {
		t.Fatalf("fully attached effective policy stayed unavailable: %v", err)
	}
	err = service.k8sClient.Get(t.Context(), ctrlclient.ObjectKey{Namespace: workspace, Name: name + "-telemetry"}, telemetry)
	if err != nil {
		t.Fatal(err)
	}
	telemetry.Status.Ancestors = []gwv1.PolicyAncestorStatus{{
		AncestorRef:    gwv1.ParentReference{Name: inference.GatewayName},
		ControllerName: "agentgateway.dev/agentgateway",
		Conditions:     []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue}},
	}}
	if err := service.k8sClient.Update(t.Context(), telemetry); err != nil {
		t.Fatal(err)
	}
	err = service.delegationReady(t.Context(), grant, workspace, inference.GatewayName, name, name+"-telemetry")
	if err == nil {
		t.Fatal("guardrail attachment alone admitted a route whose shared audit transformation was not attached")
	}
	telemetry.Status.Ancestors[0].Conditions = conditions
	if err := service.k8sClient.Update(t.Context(), telemetry); err != nil {
		t.Fatal(err)
	}
	guard.Annotations["agentz.accuknox.com/guardrail-revision"] = "stale"
	if err := service.k8sClient.Update(t.Context(), guard); err != nil {
		t.Fatal(err)
	}
	err = service.delegationReady(t.Context(), grant, workspace, inference.GatewayName, name, name+"-telemetry")
	if err == nil {
		t.Fatal("stale mandatory guardrail revision was accepted")
	}
}
