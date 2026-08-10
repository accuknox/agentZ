package sandbox

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestValidatorValidateCreateRejectsInvalidAllowedHosts(t *testing.T) {
	t.Parallel()

	sandbox := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sandbox"},
		Spec: agentzv1alpha1.SandboxSpec{
			AllowedHosts: []string{"api.*.github.com", "10.0.0.1"},
		},
	}

	_, err := NewValidator(nil).ValidateCreate(context.Background(), sandbox)
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly succeeded")
	}
}

func TestValidatorValidateDeleteRejectsReferencedSandbox(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	client := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
			Spec: agentzv1alpha1.AgentSpec{
				SandboxRef: agentzv1alpha1.ResourceReference{
					Scope: agentzv1alpha1.ResourceScopeOrganisation,
					Name:  "sandbox",
				},
			},
		}).
		Build()

	sandbox := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: "default"},
	}

	_, err := NewValidator(client).ValidateDelete(context.Background(), sandbox)
	if err == nil {
		t.Fatal("ValidateDelete() unexpectedly succeeded")
	}
}

func TestValidatorValidateCreateAllowsProviderHost(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	namespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: "default",
		Labels: map[string]string{
			agentzv1alpha1.TenantNameLabel: "default",
		},
	}}
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "private", Namespace: "default"},
		Spec: agentzv1alpha1.InferenceProviderSpec{
			OpenAICompatible: &agentzv1alpha1.CompatibleProviderConfig{
				BaseURL: "https://api.internal.example/v1",
			},
			Models: []agentzv1alpha1.InferenceModel{{ID: "model"}},
		},
	}
	client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(namespace, provider).Build()
	model := agentzv1alpha1.InferenceModelRef{
		Scope:    agentzv1alpha1.ResourceScopeOrganisation,
		Provider: "private",
		Model:    "model",
	}
	sandbox := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: "default"},
		Spec: agentzv1alpha1.SandboxSpec{
			AllowedHosts: []string{"**.internal.example"},
			Inference: agentzv1alpha1.SandboxInference{
				Models: []agentzv1alpha1.InferenceModelRef{model}, DefaultModel: model,
			},
		},
	}

	_, err := NewValidator(client).ValidateCreate(context.Background(), sandbox)
	if err != nil {
		t.Fatalf("ValidateCreate() error = %v", err)
	}
}

func TestValidatorValidateCreateAllowsWorkspaceResources(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}

	const workspaceName = "workspace"
	organizationNamespace := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		"organization-id",
	)
	workspace := &agentzv1alpha1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: workspaceName},
		Spec: agentzv1alpha1.WorkspaceSpec{
			WorkspaceID:    "workspace-id",
			OrganizationID: "organization-id",
			SelectedOrganizationResources: agentzv1alpha1.SelectedOrganizationResources{
				MCPConnections:     []string{"shared-mcp"},
				InferenceProviders: []string{"shared-provider"},
			},
		},
	}
	workspaceNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: workspaceName,
		Labels: map[string]string{
			agentzv1alpha1.WorkspaceNameLabel:        workspaceName,
			agentzv1alpha1.TenantOrganizationIDLabel: organizationNamespace,
		},
	}}
	skill := &agentzv1alpha1.Skill{
		ObjectMeta: metav1.ObjectMeta{Name: "local-skill", Namespace: workspaceName},
	}
	conn := &agentzv1alpha1.MCPConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "shared-mcp", Namespace: organizationNamespace},
		Status: agentzv1alpha1.MCPConnectionStatus{
			ToolCatalogReady: true,
			Tools:            []agentzv1alpha1.MCPConnectionTool{{Name: "search"}},
		},
	}
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "shared-provider", Namespace: organizationNamespace},
		Spec: agentzv1alpha1.InferenceProviderSpec{
			Models: []agentzv1alpha1.InferenceModel{{ID: "model"}},
		},
	}
	client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		workspace,
		workspaceNamespace,
		skill,
		conn,
		provider,
	).Build()
	model := agentzv1alpha1.InferenceModelRef{
		Scope:    agentzv1alpha1.ResourceScopeOrganisation,
		Provider: "shared-provider",
		Model:    "model",
	}
	sandbox := &agentzv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: workspaceName},
		Spec: agentzv1alpha1.SandboxSpec{
			Skills: []agentzv1alpha1.ResourceReference{{
				Scope: agentzv1alpha1.ResourceScopeWorkspace,
				Name:  "local-skill",
			}},
			MCPConnectionRefs: []agentzv1alpha1.MCPConnectionRef{{
				ResourceReference: agentzv1alpha1.ResourceReference{
					Scope: agentzv1alpha1.ResourceScopeOrganisation,
					Name:  "shared-mcp",
				},
				Tools: []agentzv1alpha1.SandboxMCPTool{{Name: "search"}},
			}},
			Inference: agentzv1alpha1.SandboxInference{
				Models:       []agentzv1alpha1.InferenceModelRef{model},
				DefaultModel: model,
			},
		},
	}

	_, err := NewValidator(client).ValidateCreate(context.Background(), sandbox)
	if err != nil {
		t.Fatalf("ValidateCreate() error = %v", err)
	}
}
