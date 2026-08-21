package agent

import (
	"context"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestDefaulterCopiesTenantResourcesOnCreate(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	tenantName := "org-tenant"
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: "workspace",
			Labels: map[string]string{
				agentzv1alpha1.TenantOrganizationIDLabel: tenantName,
			},
		}},
		&agentzv1alpha1.Tenant{
			ObjectMeta: metav1.ObjectMeta{Name: tenantName},
			Spec: agentzv1alpha1.TenantSpec{AgentQuota: &agentzv1alpha1.AgentQuota{
				Defaults: agentzv1alpha1.AgentDefaults{
					Resources: agentzv1alpha1.ComputeResources{
						CPU:    resource.MustParse("500m"),
						Memory: resource.MustParse("800Mi"),
					},
					QoSClass: corev1.PodQOSGuaranteed,
				},
			}},
		},
	).Build()
	ctx := admission.NewContextWithRequest(context.Background(), admission.Request{
		AdmissionRequest: admissionv1.AdmissionRequest{Operation: admissionv1.Create},
	})
	agt := &agentzv1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{Namespace: "workspace"}}
	if err := NewDefaulter(reader, WebhookConfig{}).Default(ctx, agt); err != nil {
		t.Fatalf("Default() error = %v", err)
	}
	if got := agt.Spec.Resources.Requests[corev1.ResourceCPU]; got.Cmp(resource.MustParse("500m")) != 0 {
		t.Errorf("CPU request = %s, want 500m", got.String())
	}
	if got := agt.Spec.Resources.Limits[corev1.ResourceMemory]; got.Cmp(resource.MustParse("800Mi")) != 0 {
		t.Errorf("memory limit = %s, want 800Mi", got.String())
	}
}

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
