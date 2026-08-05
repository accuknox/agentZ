package tenant

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/event"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestTenantChangePredicate(t *testing.T) {
	t.Parallel()

	const identity = "knox-05d3f392d8021c42b0434f9f5f20eac6"
	tests := []struct {
		name      string
		oldTenant *agentzv1alpha1.Tenant
		newTenant *agentzv1alpha1.Tenant
		want      bool
	}{
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
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			e := event.UpdateEvent{ObjectOld: tt.oldTenant, ObjectNew: tt.newTenant}
			if got := p.Update(e); got != tt.want {
				t.Fatalf("Update() = %v, want %v", got, tt.want)
			}
		})
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
