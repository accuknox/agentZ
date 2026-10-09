package gateway

import (
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type agentModelCatalogTest struct {
	name      string
	model     agentzv1alpha1.InferenceModelRef
	providers []string
}

func TestAgentModelCatalog(t *testing.T) {
	s := sandboxTestService(t, nil)
	org := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeOrganisation, testOrganizationID)
	var inherited agentzv1alpha1.InferenceProvider
	key := client.ObjectKey{Namespace: org, Name: "provider"}
	err := s.k8sClient.Get(t.Context(), key, &inherited)
	if err != nil {
		t.Fatal(err)
	}
	inherited.Spec.CatalogProvider = "openai"
	if err := s.k8sClient.Update(t.Context(), &inherited); err != nil {
		t.Fatal(err)
	}
	local := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "provider", Namespace: testWorkspaceNS},
		Spec:       agentzv1alpha1.InferenceProviderSpec{CatalogProvider: "anthropic"},
	}
	if err := s.k8sClient.Create(t.Context(), local); err != nil {
		t.Fatal(err)
	}
	pool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "mixed", Namespace: testWorkspaceNS},
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "first"},
			{Scope: agentzv1alpha1.ResourceScopeWorkspace, Provider: "provider", Model: "second"},
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "third"},
		}},
	}
	if err := s.k8sClient.Create(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	inheritedPool := &agentzv1alpha1.InferencePool{
		ObjectMeta: metav1.ObjectMeta{Name: "inherited", Namespace: org},
		Spec: agentzv1alpha1.InferencePoolSpec{Members: []agentzv1alpha1.InferencePoolMember{
			{Scope: agentzv1alpha1.ResourceScopeOrganisation, Provider: "provider", Model: "first"},
		}},
	}
	if err := s.k8sClient.Create(t.Context(), inheritedPool); err != nil {
		t.Fatal(err)
	}
	tests := []agentModelCatalogTest{
		{
			name: "workspace provider",
			model: agentzv1alpha1.InferenceModelRef{
				Scope:    agentzv1alpha1.ResourceScopeWorkspace,
				Provider: "provider",
				Model:    "model",
			},
			providers: []string{"anthropic"},
		},
		{
			name: "inherited provider",
			model: agentzv1alpha1.InferenceModelRef{
				Scope:    agentzv1alpha1.ResourceScopeOrganisation,
				Provider: "provider",
				Model:    "model",
			},
			providers: []string{"openai"},
		},
		{
			name: "pool members retain scope and deduplicate brands",
			model: agentzv1alpha1.InferenceModelRef{
				Scope:    agentzv1alpha1.ResourceScopeWorkspace,
				Provider: agentzv1alpha1.InferencePoolProvider,
				Model:    "mixed",
			},
			providers: []string{"openai", "anthropic"},
		},
		{
			name: "inherited pool",
			model: agentzv1alpha1.InferenceModelRef{
				Scope:    agentzv1alpha1.ResourceScopeOrganisation,
				Provider: agentzv1alpha1.InferencePoolProvider,
				Model:    "inherited",
			},
			providers: []string{"openai"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sandbox := &agentzv1alpha1.Sandbox{
				ObjectMeta: metav1.ObjectMeta{Namespace: testWorkspaceNS},
				Spec: agentzv1alpha1.SandboxSpec{
					Inference: agentzv1alpha1.SandboxInference{
						Models: []agentzv1alpha1.InferenceModelRef{tt.model},
					},
				},
			}
			got, err := agentModelCatalog(t.Context(), s.k8sClient, sandbox)
			if err != nil {
				t.Fatal(err)
			}
			want := []gatewayapi.AgentModelCatalogEntry{{
				ProviderId: tt.model.Provider,
				ModelId:    tt.model.Model,
				Providers:  tt.providers,
			}}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("catalog = %#v, want %#v", got, want)
			}
		})
	}
	t.Run("unselected organization provider", func(t *testing.T) {
		var workspace agentzv1alpha1.Workspace
		key := client.ObjectKey{Name: testWorkspaceNS}
		err := s.k8sClient.Get(t.Context(), key, &workspace)
		if err != nil {
			t.Fatal(err)
		}
		workspace.Spec.SelectedOrganizationResources.InferenceProviders = nil
		if err := s.k8sClient.Update(t.Context(), &workspace); err != nil {
			t.Fatal(err)
		}
		sandbox := &agentzv1alpha1.Sandbox{
			ObjectMeta: metav1.ObjectMeta{Namespace: testWorkspaceNS},
			Spec: agentzv1alpha1.SandboxSpec{
				Inference: agentzv1alpha1.SandboxInference{
					Models: []agentzv1alpha1.InferenceModelRef{{
						Scope:    agentzv1alpha1.ResourceScopeOrganisation,
						Provider: "provider",
						Model:    "model",
					}},
				},
			},
		}
		if _, err := agentModelCatalog(t.Context(), s.k8sClient, sandbox); err == nil {
			t.Fatal("catalog exposed an organization provider not selected by the workspace")
		}
	})

}
