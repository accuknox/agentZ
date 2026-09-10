package agent

import (
	"context"
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

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

func TestMetadataUpdatePreservesStoredDefaults(t *testing.T) {
	t.Parallel()
	old := &agentzv1alpha1.Agent{}
	old.Finalizers = []string{"agentz.accuknox.com/agent-protection"}
	raw, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	updated := old.DeepCopy()
	updated.Finalizers = nil
	ctx := admission.NewContextWithRequest(t.Context(), admission.Request{
		AdmissionRequest: admissionv1.AdmissionRequest{
			Operation: admissionv1.Update, OldObject: runtime.RawExtension{Raw: raw},
		},
	})
	defaulter := NewDefaulter(nil, WebhookConfig{AgentDefaultImage: "agent:latest"})
	if err := defaulter.Default(ctx, updated); err != nil {
		t.Fatal(err)
	}
	if !apiequality.Semantic.DeepEqual(old.Spec, updated.Spec) {
		t.Fatal("metadata update changed the stored spec")
	}
	if _, err := NewValidator(nil).ValidateUpdate(ctx, old, updated); err != nil {
		t.Fatalf("finalizer removal: %v", err)
	}
}
