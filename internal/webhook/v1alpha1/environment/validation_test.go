package environment

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

func TestValidatorValidateCreateRejectsInvalidAllowedHosts(t *testing.T) {
	t.Parallel()

	env := &clawarmorv1alpha1.Environment{
		ObjectMeta: metav1.ObjectMeta{Name: "env"},
		Spec: clawarmorv1alpha1.EnvironmentSpec{
			AllowedHosts: []string{"api.*.github.com", "10.0.0.1"},
		},
	}

	_, err := NewValidator(nil).ValidateCreate(context.Background(), env)
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly succeeded")
	}
}

func TestValidatorValidateDeleteRejectsReferencedEnvironment(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clawarmorv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme() error = %v", err)
	}

	client := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(&clawarmorv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
			Spec: clawarmorv1alpha1.AgentSpec{
				EnvironmentRef: &corev1.LocalObjectReference{Name: "env"},
			},
		}).
		Build()

	env := &clawarmorv1alpha1.Environment{
		ObjectMeta: metav1.ObjectMeta{Name: "env", Namespace: "default"},
	}

	_, err := NewValidator(client).ValidateDelete(context.Background(), env)
	if err == nil {
		t.Fatal("ValidateDelete() unexpectedly succeeded")
	}
}
