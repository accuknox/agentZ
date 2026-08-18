package agent

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestValidatorRejectsNixStoreResize(t *testing.T) {
	t.Parallel()

	validator := NewValidator(nil)
	oldAgt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent"},
		Spec: agentzv1alpha1.AgentSpec{
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeOrganisation,
				Name:  "python",
			},
			NixStoreSize: resource.MustParse("5Gi"),
		},
	}
	newAgt := oldAgt.DeepCopy()
	newAgt.Spec.NixStoreSize = resource.MustParse("10Gi")

	_, err := validator.ValidateUpdate(context.Background(), oldAgt, newAgt)
	if err == nil {
		t.Fatal("ValidateUpdate() unexpectedly accepted nixStoreSize mutation")
	}
}
