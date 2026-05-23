package agent

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

func TestValidatorValidateCreateRejectsInvalidAgentConfig(t *testing.T) {
	t.Parallel()

	agt := &clawarmorv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent"},
		Spec: clawarmorv1alpha1.AgentSpec{
			EnvironmentRef: &corev1.LocalObjectReference{},
			Model:          "gpt-5",
			Instruction:    strings.Repeat("a", 4097),
			Providers: map[string]clawarmorv1alpha1.OpencodeProviderConfig{
				"openai": {
					Env:     []string{"bad-name"},
					BaseURL: "/v1",
				},
			},
		},
	}

	_, err := NewValidator().ValidateCreate(context.Background(), agt)
	if err == nil {
		t.Fatal("ValidateCreate() unexpectedly succeeded")
	}
}

func TestValidatorValidateUpdateRejectsMutableAndAcceptsValidFields(t *testing.T) {
	t.Parallel()

	validator := NewValidator()
	oldAgt := &clawarmorv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent"},
		Spec: clawarmorv1alpha1.AgentSpec{
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
	valid.Spec.EnvironmentRef = &corev1.LocalObjectReference{Name: "python"}
	valid.Spec.Model = "openai/gpt-5"
	valid.Spec.SmallModel = "openai/gpt-5-mini"
	valid.Spec.Instruction = "Follow repository instructions strictly."
	valid.Spec.Providers = map[string]clawarmorv1alpha1.OpencodeProviderConfig{
		"openai": {
			Env:     []string{"OPENAI_API_KEY"},
			BaseURL: "https://api.openai.com/v1",
		},
	}

	_, err = validator.ValidateUpdate(context.Background(), oldAgt, valid)
	if err != nil {
		t.Fatalf("ValidateUpdate() error = %v", err)
	}
}
