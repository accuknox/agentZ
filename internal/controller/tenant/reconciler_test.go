package tenant

import (
	"context"
	"testing"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/event"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestReconcileIsolationPolicyUsesManagerNamespace(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	utilruntime.Must(ciliumv2.AddToScheme(scheme))
	utilruntime.Must(agentzv1alpha1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	r := &Reconciler{
		Client:                         c,
		Scheme:                         scheme,
		ManagerServiceAccountNamespace: "custom-system",
	}
	tenant := &agentzv1alpha1.Tenant{ObjectMeta: metav1.ObjectMeta{
		Name: "org-05d3f392d8021c42b0434f9f5f20eac6",
		UID:  "tenant-uid",
	}}
	err := r.reconcileIsolationPolicy(context.Background(), tenant, tenant.Name)
	if err != nil {
		t.Fatalf("reconcileIsolationPolicy() error = %v", err)
	}

	policy := &ciliumv2.CiliumNetworkPolicy{}
	key := client.ObjectKey{Name: agentzv1alpha1.TenantIsolationPolicyName, Namespace: tenant.Name}
	if err := c.Get(context.Background(), key, policy); err != nil {
		t.Fatalf("get CiliumNetworkPolicy: %v", err)
	}
	got := policy.Spec.Ingress[1].FromEndpoints[0].MatchLabels["k8s:io.kubernetes.pod.namespace"]
	if got != r.ManagerServiceAccountNamespace {
		t.Fatalf("manager namespace selector = %q, want %q", got, r.ManagerServiceAccountNamespace)
	}
}

type tenantChangePredicateCase struct {
	name      string
	oldTenant *agentzv1alpha1.Tenant
	newTenant *agentzv1alpha1.Tenant
	want      bool
}

func TestTenantChangePredicate(t *testing.T) {
	t.Parallel()

	const identity = "org-05d3f392d8021c42b0434f9f5f20eac6"
	tests := []tenantChangePredicateCase{
		{
			name:      "generation change",
			oldTenant: tenantForPredicate(1, identity, "old"),
			newTenant: tenantForPredicate(2, identity, "old"),
			want:      true,
		},
		{
			name:      "identity label added",
			oldTenant: tenantForPredicate(1, "", "old"),
			newTenant: tenantForPredicate(1, identity, "old"),
			want:      true,
		},
		{
			name:      "identity label changed",
			oldTenant: tenantForPredicate(1, "incorrect", "old"),
			newTenant: tenantForPredicate(1, identity, "old"),
			want:      true,
		},
		{
			name:      "identity label removed",
			oldTenant: tenantForPredicate(1, identity, "old"),
			newTenant: tenantForPredicate(1, "", "old"),
			want:      true,
		},
		{
			name:      "unrelated label change",
			oldTenant: tenantForPredicate(1, identity, "old"),
			newTenant: tenantForPredicate(1, identity, "new"),
		},
		{
			name:      "status-only update",
			oldTenant: tenantForPredicate(1, identity, "old"),
			newTenant: tenantForPredicate(1, identity, "old"),
		},
	}

	p := tenantChangePredicate()
	for _, tt := range tests {
		t.Run(
			tt.name,
			func(t *testing.T) {
				t.Parallel()
				e := event.UpdateEvent{ObjectOld: tt.oldTenant, ObjectNew: tt.newTenant}
				if got := p.Update(e); got != tt.want {
					t.Fatalf("Update() = %v, want %v", got, tt.want)
				}
			},
		)
	}
}

func tenantForPredicate(generation int64, identity, unrelated string) *agentzv1alpha1.Tenant {
	labels := map[string]string{"example.com/unrelated": unrelated}
	if identity != "" {
		labels[agentzv1alpha1.TenantOrganizationIDLabel] = identity
	}
	return &agentzv1alpha1.Tenant{ObjectMeta: metav1.ObjectMeta{
		Generation: generation,
		Labels:     labels,
	}}
}
