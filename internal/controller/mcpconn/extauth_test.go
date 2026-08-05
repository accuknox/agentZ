package mcpconn

import (
	"context"
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestExtAuthAccessIsLimitedToOrganizationWorkspaces(t *testing.T) {
	t.Parallel()

	const organizationID = "organization-a"
	org := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	allowed := workspaceForExtAuth("workspace-a", organizationID)
	foreign := workspaceForExtAuth("workspace-b", "organization-b")
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: org,
		Annotations: map[string]string{
			agentzv1alpha1.TenantOrganizationIDAnnotation: organizationID,
		},
	}}

	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		corev1.AddToScheme,
		rbacv1.AddToScheme,
		agentzv1alpha1.AddToScheme,
	} {
		if err := add(scheme); err != nil {
			t.Fatalf("add scheme: %v", err)
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(ns, allowed, foreign).Build()
	r := &ExtAuthRuntimeReconciler{Client: c}
	access, err := r.workspaceAccess(context.Background(), ns)
	if err != nil {
		t.Fatalf("workspaceAccess() error = %v", err)
	}
	if len(access) != 1 || access[0].namespace != allowed.Name {
		t.Fatalf("workspaceAccess() = %#v, want only %q", access, allowed.Name)
	}

	labels := map[string]string{"app.kubernetes.io/name": extAuthLabelName}
	ownerRefs := []metav1.OwnerReference{{APIVersion: "v1", Kind: "Namespace", Name: org}}
	if err := r.reconcileExtAuthScopeReader(context.Background(), org, access, labels, ownerRefs); err != nil {
		t.Fatalf("reconcileExtAuthScopeReader() error = %v", err)
	}
	if err := r.reconcileExtAuthWorkspaceAccess(context.Background(), org, access, labels); err != nil {
		t.Fatalf("reconcileExtAuthWorkspaceAccess() error = %v", err)
	}

	role := &rbacv1.ClusterRole{}
	name := mcp.ExtAuthOpenBaoName(org) + "-scope-reader"
	if err := c.Get(context.Background(), client.ObjectKey{Name: name}, role); err != nil {
		t.Fatalf("get scope reader ClusterRole: %v", err)
	}
	for _, rule := range role.Rules {
		if slices.Contains(rule.Resources, "pods") || slices.Contains(rule.Resources, "agents") {
			t.Fatalf("scope reader grants cluster-wide workload access: %#v", rule)
		}
	}

	workspaceRole := &rbacv1.Role{}
	key := client.ObjectKey{Namespace: allowed.Name, Name: mcp.ExtAuthServiceName}
	if err := c.Get(context.Background(), key, workspaceRole); err != nil {
		t.Fatalf("get allowed workspace Role: %v", err)
	}
	key.Namespace = foreign.Name
	err = c.Get(context.Background(), key, &rbacv1.Role{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("foreign workspace Role unexpectedly exists: %v", err)
	}
}

func workspaceForExtAuth(id, organizationID string) *agentzv1alpha1.Workspace {
	name := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, id)
	return &agentzv1alpha1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: name, UID: types.UID("uid-" + name)},
		Spec: agentzv1alpha1.WorkspaceSpec{
			WorkspaceID:    id,
			OrganizationID: organizationID,
		},
	}
}
