/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package sandbox

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"

	agentgatewayv1alpha1 "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	agentgatewayfake "github.com/agentgateway/agentgateway/controller/pkg/client/clientset/versioned/fake"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	ctrlutil "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/networkpolicy"
	"github.com/accuknox/agentz/internal/sandboxutil"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestReconcileMCPAgentRouteIdentity(t *testing.T) {
	t.Parallel()

	const (
		namespace   = "workspace"
		agentName   = "agent"
		sandboxName = "sandbox"
		wantPath    = "/mcp/agents/workspace/agent/sandboxes/sandbox"
	)
	scheme := runtime.NewScheme()
	adders := []func(*runtime.Scheme) error{
		corev1.AddToScheme,
		discoveryv1.AddToScheme,
		ciliumv2.AddToScheme,
		gwv1.Install,
		agentzv1alpha1.AddToScheme,
	}
	for _, add := range adders {
		if err := add(scheme); err != nil {
			t.Fatalf("add scheme: %v", err)
		}
	}

	sandbox := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: sandboxName, Namespace: namespace},
	}
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: namespace},
		Spec: agentzv1alpha1.AgentSpec{SandboxRef: agentzv1alpha1.ResourceReference{
			Scope: agentzv1alpha1.ResourceScopeWorkspace,
			Name:  sandboxName,
		}},
	}
	k8sClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(
			&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
				Name: namespace,
				Labels: map[string]string{
					agentzv1alpha1.WorkspaceNameLabel: namespace,
				},
			}},
			sandbox,
			agt,
		).
		WithIndex(
			&agentzv1alpha1.Agent{},
			sandboxutil.AgentBySandboxIndex,
			func(obj client.Object) []string {
				agt := obj.(*agentzv1alpha1.Agent)
				return []string{agt.Spec.SandboxRef.Name}
			},
		).
		Build()
	r := &Reconciler{
		Client:       k8sClient,
		Scheme:       scheme,
		AgentGateway: agentgatewayfake.NewSimpleClientset(),
		TraceBackend: TraceBackend{
			Mode:             TraceBackendModeService,
			ServiceName:      "observer",
			ServiceNamespace: "agentz-system",
			ServicePort:      4317,
		},
	}
	ctx := context.Background()
	if err := r.reconcileRoute(ctx, sandbox); err != nil {
		t.Fatalf("reconcileRoute() error = %v", err)
	}
	if err := r.reconcileGatewayNetworkPolicy(ctx, namespace, []agentzv1alpha1.Sandbox{*sandbox}); err != nil {
		t.Fatalf("reconcileGatewayNetworkPolicy() error = %v", err)
	}
	if err := r.reconcileTracePolicy(ctx, namespace, []agentzv1alpha1.Sandbox{*sandbox}); err != nil {
		t.Fatalf("reconcileTracePolicy() error = %v", err)
	}

	route := &gwv1.HTTPRoute{}
	key := client.ObjectKey{Name: mcp.SandboxRouteName(sandboxName), Namespace: namespace}
	if err := k8sClient.Get(ctx, key, route); err != nil {
		t.Fatalf("get MCP HTTPRoute: %v", err)
	}
	if len(route.Spec.Rules) != 1 || len(route.Spec.Rules[0].Matches) != 1 {
		t.Fatalf("MCP HTTPRoute matches = %#v, want one agent match", route.Spec.Rules)
	}
	gotPath := route.Spec.Rules[0].Matches[0].Path.Value
	if gotPath == nil || *gotPath != wantPath {
		t.Fatalf("MCP HTTPRoute path = %v, want %q", gotPath, wantPath)
	}

	policy := &ciliumv2.CiliumNetworkPolicy{}
	key = client.ObjectKey{Name: mcp.GatewayName, Namespace: namespace}
	if err := k8sClient.Get(ctx, key, policy); err != nil {
		t.Fatalf("get MCP CiliumNetworkPolicy: %v", err)
	}
	wantL7Path := "^/mcp/agents/workspace/agent/sandboxes/sandbox(/.*)?$"
	gotL7Path := policy.Spec.Ingress[0].ToPorts[0].Rules.HTTP[0].Path
	if gotL7Path != wantL7Path {
		t.Fatalf("MCP CiliumNetworkPolicy path = %q, want %q", gotL7Path, wantL7Path)
	}

	tracePolicy, err := r.AgentGateway.AgentgatewayAgentgateway().
		AgentgatewayPolicies(namespace).
		Get(ctx, tracePolicyName, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get MCP trace policy: %v", err)
	}
	attrs := map[agentgatewayv1alpha1.ShortString]agentgatewayv1alpha1.CELExpression{}
	for _, attr := range tracePolicy.Spec.Frontend.Tracing.Attributes.Add {
		attrs[attr.Name] = attr.Expression
	}
	wantTenant := agentgatewayv1alpha1.CELExpression(`request.path.split("/")[3]`)
	wantAgent := agentgatewayv1alpha1.CELExpression(`request.path.split("/")[4]`)
	if attrs[agentgatewayv1alpha1.ShortString("agentz.tenant_namespace")] != wantTenant {
		t.Fatalf("tenant trace attribute = %q, want %q", attrs["agentz.tenant_namespace"], wantTenant)
	}
	if attrs[agentgatewayv1alpha1.ShortString("agentz.agent_name")] != wantAgent {
		t.Fatalf("agent trace attribute = %q, want %q", attrs["agentz.agent_name"], wantAgent)
	}

	if err := k8sClient.Delete(ctx, agt); err != nil {
		t.Fatalf("delete Agent: %v", err)
	}
	if err := r.reconcileRoute(ctx, sandbox); err != nil {
		t.Fatalf("reconcileRoute() after Agent deletion error = %v", err)
	}
	key = client.ObjectKey{Name: mcp.SandboxRouteName(sandboxName), Namespace: namespace}
	if err := k8sClient.Get(ctx, key, route); !apierrors.IsNotFound(err) {
		t.Fatalf("get MCP HTTPRoute after Agent deletion error = %v, want not found", err)
	}
}

func TestGatewayNetworkPolicySpecTraceEgress(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		backend TraceBackend
		want    []ciliumapi.EgressRule
	}{
		{
			name: "service",
			backend: TraceBackend{
				Mode:             TraceBackendModeService,
				ServiceName:      "observer",
				ServiceNamespace: "agentz-system",
				ServicePort:      4317,
			},
			want: networkpolicy.ServiceEgress("agentz-system", "observer", 4317),
		},
		{
			name: "static",
			backend: TraceBackend{
				Mode: TraceBackendModeStatic,
				Host: "otel.example.com",
				Port: 4317,
			},
			want: networkpolicy.ExternalEgress([]networkpolicy.Target{{
				Host: "otel.example.com",
				Port: 4317,
			}}),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := gatewayNetworkPolicySpec(
				"workspace",
				mcp.GatewayName,
				tt.backend,
			)
			// The base permits same-namespace workloads and the control plane only.
			wantRuleCount := 3 + len(tt.want)
			if len(policy.Egress) != wantRuleCount {
				t.Fatalf(
					"gateway policy has %d egress rules, want %d",
					len(policy.Egress),
					wantRuleCount,
				)
			}
			for _, want := range tt.want {
				if !slices.ContainsFunc(policy.Egress, func(got ciliumapi.EgressRule) bool {
					return reflect.DeepEqual(got, want)
				}) {
					t.Fatalf("gateway policy does not contain trace egress %#v", want)
				}
			}
			for _, rule := range policy.Egress {
				if slices.Contains(rule.ToEntities, ciliumapi.EntityAll) {
					t.Fatal("gateway policy permits egress to all entities")
				}
			}
		})
	}
}

func TestReconcileInferenceGatewayExtAuthEgress(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		provider    agentzv1alpha1.InferenceProviderSpec
		wantExtAuth bool
	}{
		{
			name: "subscription provider",
			provider: agentzv1alpha1.InferenceProviderSpec{
				Kind: agentzv1alpha1.InferenceProviderKindOpenAICodex,
			},
			wantExtAuth: true,
		},
		{
			name: "API key provider",
			provider: agentzv1alpha1.InferenceProviderSpec{
				Kind:      agentzv1alpha1.InferenceProviderKindAnthropic,
				Anthropic: &agentzv1alpha1.AnthropicProviderConfig{},
			},
			wantExtAuth: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			const (
				organizationID = "organization-id"
				workspaceID    = "workspace-id"
				providerName   = "provider"
			)
			organizationNamespace := agentzv1alpha1.ScopeNamespace(
				agentzv1alpha1.ResourceScopeOrganisation,
				organizationID,
			)
			workspaceNamespace := agentzv1alpha1.ScopeNamespace(
				agentzv1alpha1.ResourceScopeWorkspace,
				workspaceID,
			)

			scheme := runtime.NewScheme()
			adders := []func(*runtime.Scheme) error{
				corev1.AddToScheme,
				ciliumv2.AddToScheme,
				gwv1.Install,
				agentgatewayv1alpha1.Install,
				agentzv1alpha1.AddToScheme,
			}
			for _, add := range adders {
				if err := add(scheme); err != nil {
					t.Fatalf("add scheme: %v", err)
				}
			}

			objects := []client.Object{
				&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
					Name: workspaceNamespace,
					Labels: map[string]string{
						agentzv1alpha1.WorkspaceNameLabel:        workspaceNamespace,
						agentzv1alpha1.TenantOrganizationIDLabel: organizationNamespace,
					},
				}},
				&agentzv1alpha1.Workspace{
					ObjectMeta: metav1.ObjectMeta{Name: workspaceNamespace},
					Spec: agentzv1alpha1.WorkspaceSpec{
						WorkspaceID:    workspaceID,
						OrganizationID: organizationID,
						SelectedOrganizationResources: agentzv1alpha1.SelectedOrganizationResources{
							InferenceProviders: []string{providerName},
						},
					},
				},
				&agentzv1alpha1.Sandbox{
					ObjectMeta: metav1.ObjectMeta{
						Name:      "debug",
						Namespace: workspaceNamespace,
					},
					Spec: agentzv1alpha1.SandboxSpec{
						Inference: agentzv1alpha1.SandboxInference{
							Models: []agentzv1alpha1.InferenceModelRef{{
								Scope:    agentzv1alpha1.ResourceScopeOrganisation,
								Provider: providerName,
								Model:    "model",
							}},
						},
					},
				},
				&agentzv1alpha1.InferenceProvider{
					ObjectMeta: metav1.ObjectMeta{
						Name:      providerName,
						Namespace: organizationNamespace,
					},
					Spec: tt.provider,
				},
			}
			k8sClient := fake.NewClientBuilder().
				WithScheme(scheme).
				WithObjects(objects...).
				WithIndex(
					&agentzv1alpha1.Agent{},
					sandboxutil.AgentBySandboxIndex,
					func(obj client.Object) []string {
						agt := obj.(*agentzv1alpha1.Agent)
						return []string{agt.Spec.SandboxRef.Name}
					},
				).
				Build()
			r := &Reconciler{
				Client:       k8sClient,
				Scheme:       scheme,
				AgentGateway: agentgatewayfake.NewSimpleClientset(),
				TraceBackend: TraceBackend{
					Mode:             TraceBackendModeService,
					ServiceName:      "observer",
					ServiceNamespace: "agentz-system",
					ServicePort:      4317,
				},
			}
			if err := r.reconcileInferenceGateway(context.Background(), workspaceNamespace); err != nil {
				t.Fatalf("reconcileInferenceGateway() error = %v", err)
			}

			policy := &ciliumv2.CiliumNetworkPolicy{}
			key := client.ObjectKey{Name: inference.GatewayName, Namespace: workspaceNamespace}
			if err := k8sClient.Get(context.Background(), key, policy); err != nil {
				t.Fatalf("get inference CiliumNetworkPolicy: %v", err)
			}
			want := networkpolicy.ServiceEgress(
				organizationNamespace,
				mcp.ExtAuthServiceName,
				mcp.ExtAuthPort,
			)[0]
			var hasExtAuth bool
			for _, rule := range policy.Spec.Egress {
				if !reflect.DeepEqual(rule.ToServices, want.ToServices) {
					continue
				}
				hasExtAuth = true
				if !reflect.DeepEqual(rule, want) {
					t.Fatalf("extAuth egress = %#v, want %#v", rule, want)
				}
			}
			if hasExtAuth != tt.wantExtAuth {
				t.Fatalf(
					"inference CiliumNetworkPolicy extAuth egress = %t, want %t",
					hasExtAuth,
					tt.wantExtAuth,
				)
			}
		})
	}
}

func TestReconcileDeletionFindsOrganisationSandboxAgentAcrossWorkspaces(t *testing.T) {
	t.Parallel()

	const (
		organizationID = "organization-id"
		workspaceID    = "workspace-id"
		sandboxName    = "shared-sandbox"
	)
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	workspaceNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeWorkspace,
		workspaceID,
	)

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme(core) error = %v", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme(agentz) error = %v", err)
	}

	now := metav1.Now()
	sandbox := &agentzv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{
		Name:              sandboxName,
		Namespace:         organizationNamespace,
		DeletionTimestamp: &now,
		Finalizers:        []string{mcp.SandboxFinalizer},
	}}
	objects := []client.Object{
		sandbox,
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: organizationNamespace,
			Labels: map[string]string{
				agentzv1alpha1.TenantNameLabel: organizationNamespace,
			},
		}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: workspaceNamespace,
			Labels: map[string]string{
				agentzv1alpha1.WorkspaceNameLabel:        workspaceNamespace,
				agentzv1alpha1.TenantOrganizationIDLabel: organizationNamespace,
			},
		}},
		&agentzv1alpha1.Workspace{
			ObjectMeta: metav1.ObjectMeta{Name: workspaceNamespace},
			Spec: agentzv1alpha1.WorkspaceSpec{
				WorkspaceID:    workspaceID,
				OrganizationID: organizationID,
				SelectedOrganizationResources: agentzv1alpha1.SelectedOrganizationResources{
					Sandboxes: []string{sandboxName},
				},
			},
		},
		&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "organisation-agent", Namespace: workspaceNamespace},
			Spec: agentzv1alpha1.AgentSpec{SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeOrganisation,
				Name:  sandboxName,
			}},
		},
		&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "workspace-agent", Namespace: workspaceNamespace},
			Spec: agentzv1alpha1.AgentSpec{SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeWorkspace,
				Name:  sandboxName,
			}},
		},
	}
	k8sClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(objects...).
		WithIndex(
			&agentzv1alpha1.Agent{},
			sandboxutil.AgentBySandboxIndex,
			func(obj client.Object) []string {
				agt := obj.(*agentzv1alpha1.Agent)
				return []string{agt.Spec.SandboxRef.Name}
			},
		).
		Build()
	r := &Reconciler{Client: k8sClient, Scheme: scheme}
	referencing, err := r.referencingAgents(context.Background(), sandbox)
	if err != nil {
		t.Fatalf("referencingAgents() error = %v", err)
	}
	if len(referencing) != 1 || referencing[0].Namespace != workspaceNamespace {
		t.Fatalf(
			"referencingAgents() = %#v, want the Organisation Agent in %q",
			referencing,
			workspaceNamespace,
		)
	}

	_, err = r.Reconcile(
		context.Background(),
		ctrl.Request{
			NamespacedName: client.ObjectKeyFromObject(sandbox),
		},
	)
	if err == nil || !strings.Contains(err.Error(), `agent "organisation-agent"`) {
		t.Fatalf("Reconcile() error = %v, want Organisation Sandbox reference", err)
	}

	current := &agentzv1alpha1.Sandbox{}
	err = k8sClient.Get(
		context.Background(),
		client.ObjectKeyFromObject(sandbox),
		current,
	)
	if err != nil {
		t.Fatalf("Get(Sandbox) error = %v", err)
	}
	if !ctrlutil.ContainsFinalizer(current, mcp.SandboxFinalizer) {
		t.Fatal("Reconcile() removed the finalizer from a referenced Sandbox")
	}
}
