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
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}

	client := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
			Spec: agentzv1alpha1.AgentSpec{
				SandboxRef: corev1.LocalObjectReference{Name: "sandbox"},
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

func TestValidatorValidateCreateRejectsDirectProviderEgress(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metav1.ObjectMeta{Name: "private", Namespace: "default"},
		Spec: agentzv1alpha1.InferenceProviderSpec{
			OpenAICompatible: &agentzv1alpha1.CompatibleProviderConfig{
				BaseURL: "https://api.internal.example/v1",
			},
			Models: []agentzv1alpha1.InferenceModel{{ID: "model"}},
		},
	}
	client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(provider).Build()
	model := agentzv1alpha1.InferenceModelRef{Provider: "private", Model: "model"}
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
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly allowed direct provider egress")
	}
}
