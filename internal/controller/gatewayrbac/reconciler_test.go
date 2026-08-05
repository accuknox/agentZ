package gatewayrbac

import (
	"context"
	"testing"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestReconcileGrantsOnlyTargetNamespace(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := rbacv1.AddToScheme(scheme); err != nil {
		t.Fatalf("add RBAC scheme: %v", err)
	}
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	owner := metav1.OwnerReference{
		APIVersion: "agentz.accuknox.com/v1alpha1",
		Kind:       "Workspace",
		Name:       "workspace-a",
		UID:        "workspace-uid",
		Controller: new(true),
	}
	err := Reconcile(context.Background(), c, Config{
		Namespace:               "workspace-a",
		ServiceAccountName:      "gateway",
		ServiceAccountNamespace: "agentz-system",
		Owner:                   owner,
	})
	if err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	role := &rbacv1.Role{}
	key := client.ObjectKey{Namespace: "workspace-a", Name: accessName}
	if err := c.Get(context.Background(), key, role); err != nil {
		t.Fatalf("get Role: %v", err)
	}
	if len(role.Rules) == 0 {
		t.Fatal("Role has no rules")
	}

	binding := &rbacv1.RoleBinding{}
	if err := c.Get(context.Background(), key, binding); err != nil {
		t.Fatalf("get RoleBinding: %v", err)
	}
	if len(binding.Subjects) != 1 {
		t.Fatalf("RoleBinding subjects = %d, want 1", len(binding.Subjects))
	}
	want := rbacv1.Subject{
		Kind:      rbacv1.ServiceAccountKind,
		Name:      "gateway",
		Namespace: "agentz-system",
	}
	if binding.Subjects[0] != want {
		t.Fatalf("RoleBinding subject = %#v, want %#v", binding.Subjects[0], want)
	}
}
