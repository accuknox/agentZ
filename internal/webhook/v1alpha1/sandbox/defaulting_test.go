package sandbox

import (
	"encoding/json"
	"strings"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestDefaulterDefaultParsesAndDeduplicatesHosts(t *testing.T) {
	t.Parallel()

	sandbox := &agentzv1alpha1.Sandbox{
		Spec: agentzv1alpha1.SandboxSpec{
			AllowedHosts: []string{
				" GitHub.com ",
				"*.GitHub.com",
				"**.GitHub.com",
				"10.0.0.4/24",
				"github.com",
			},
		},
	}

	ctx := admission.NewContextWithRequest(t.Context(), admission.Request{
		AdmissionRequest: admissionv1.AdmissionRequest{Operation: admissionv1.Create},
	})
	if err := NewDefaulter().Default(ctx, sandbox); err != nil {
		t.Fatalf("Default() error = %v", err)
	}

	got := "[" + strings.Join(sandbox.Spec.AllowedHosts, ",") + "]"
	want := "[github.com,*.github.com,**.github.com,10.0.0.0/24]"
	if got != want {
		t.Fatalf("AllowedHosts = %s, want %s", got, want)
	}
}

func TestMetadataUpdatePreservesStoredDefaults(t *testing.T) {
	t.Parallel()
	old := &agentzv1alpha1.Sandbox{}
	old.Finalizers = []string{"agentz.accuknox.com/sandbox-protection"}
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
	if err := NewDefaulter().Default(ctx, updated); err != nil {
		t.Fatal(err)
	}
	if !apiequality.Semantic.DeepEqual(old.Spec, updated.Spec) {
		t.Fatal("metadata update changed the stored spec")
	}
	if _, err := NewValidator(nil).ValidateUpdate(ctx, old, updated); err != nil {
		t.Fatalf("finalizer removal: %v", err)
	}
}
