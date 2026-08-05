package agent

import (
	"context"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestValidatorValidateCreateRejectsInvalidAgentConfig(t *testing.T) {
	t.Parallel()

	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent"},
		Spec: agentzv1alpha1.AgentSpec{
			SandboxRef:  agentzv1alpha1.ResourceReference{},
			Instruction: strings.Repeat("a", 4097),
		},
	}

	_, err := NewValidator(nil).ValidateCreate(context.Background(), agt)
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly succeeded")
	}
}

func TestValidatorValidateCreateRejectsReservedAgentName(t *testing.T) {
	t.Parallel()

	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: agentzv1alpha1.AgentNameMCPConnection},
	}

	_, err := NewValidator(nil).ValidateCreate(context.Background(), agt)
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly accepted reserved agent name")
	}
}

func TestValidatorValidateCreateAcceptsTypedWorkspaceReference(t *testing.T) {
	t.Parallel()

	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent"},
		Spec: agentzv1alpha1.AgentSpec{
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeWorkspace,
				Name:  "sandbox",
			},
		},
	}

	_, err := NewValidator(nil).ValidateCreate(context.Background(), agt)
	if err != nil {
		t.Fatalf("ValidateCreate() rejected a typed Workspace reference: %v", err)
	}
}

func TestValidatorValidateUpdateRejectsMutableAndAcceptsValidFields(t *testing.T) {
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

	valid := oldAgt.DeepCopy()
	valid.Spec.Instruction = "Follow repository instructions strictly."

	_, err = validator.ValidateUpdate(context.Background(), oldAgt, valid)
	if err != nil {
		t.Fatalf("ValidateUpdate() error = %v", err)
	}
}
