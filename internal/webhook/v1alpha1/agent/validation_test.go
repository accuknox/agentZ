package agent

import (
	"encoding/json"
	"errors"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type nixStoreResizeCase struct {
	name   string
	size   string
	reject bool
}

// TestValidatorNixStoreResize checks that PVC sizes can only grow.
func TestValidatorNixStoreResize(t *testing.T) {
	t.Parallel()

	tests := []nixStoreResizeCase{
		{name: "increase", size: "20Gi"},
		{name: "unchanged", size: "5Gi"},
		{name: "equivalent units", size: "5120Mi"},
		{name: "decrease", size: "4Gi", reject: true},
		{name: "clear", size: "0", reject: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
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
			newAgt.Spec.NixStoreSize = resource.MustParse(tt.size)

			validator := NewValidator(nil)
			_, err := validator.ValidateUpdate(t.Context(), oldAgt, newAgt)
			if !tt.reject {
				if err != nil {
					t.Fatalf("ValidateUpdate(): %v", err)
				}
				return
			}
			var status *apierrors.StatusError
			if !errors.As(err, &status) || !apierrors.IsInvalid(err) {
				t.Fatalf("ValidateUpdate() = %v, want Invalid error", err)
			}
			causes := status.ErrStatus.Details.Causes
			if len(causes) != 1 || causes[0].Field != "spec.nixStoreSize" {
				t.Fatalf("unexpected validation causes: %v", causes)
			}
		})
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
