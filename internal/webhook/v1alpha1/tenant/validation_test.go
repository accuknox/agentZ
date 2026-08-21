package v1alpha1

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestValidatorRejectsAgentCountDecrease(t *testing.T) {
	t.Parallel()

	oldTenant := tenantWithQuota("tenant", "1")
	newTenant := oldTenant.DeepCopy()
	newTenant.Spec.AgentQuota.Count--

	_, err := (&Validator{}).ValidateUpdate(context.Background(), oldTenant, newTenant)
	if err == nil {
		t.Fatal("ValidateUpdate() accepted an Agent count decrease")
	}
}

func TestValidatorChecksOnlyQuotaReductionsAgainstUsage(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	tenantName := "tenant"
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
			Name: "workspace",
			Labels: map[string]string{
				agentzv1alpha1.TenantOrganizationIDLabel: tenantName,
			},
		}},
		&agentzv1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
			Spec: agentzv1alpha1.AgentSpec{Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("750m"),
					corev1.ResourceMemory: resource.MustParse("800Mi"),
				},
			}},
		},
	).Build()
	validator := &Validator{reader: reader}

	oldTenant := tenantWithQuota(tenantName, "1")
	reduced := oldTenant.DeepCopy()
	reduced.Spec.AgentQuota.Resources.CPU = resource.MustParse("500m")
	if issues := validator.validateAgentQuota(context.Background(), oldTenant, reduced); len(issues) == 0 {
		t.Fatal("validateAgentQuota() accepted a CPU quota below current usage")
	}

	previouslyOverQuota := tenantWithQuota(tenantName, "500m")
	increased := previouslyOverQuota.DeepCopy()
	increased.Spec.AgentQuota.Resources.CPU = resource.MustParse("600m")
	if issues := validator.validateAgentQuota(context.Background(), previouslyOverQuota, increased); len(issues) != 0 {
		t.Fatalf("validateAgentQuota() rejected a non-decreasing quota: %v", issues)
	}
}

func tenantWithQuota(name, cpu string) *agentzv1alpha1.Tenant {
	return &agentzv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: agentzv1alpha1.TenantSpec{
			OrganizationID: "organization",
			AgentQuota: &agentzv1alpha1.AgentQuota{
				Count: 2,
				Resources: agentzv1alpha1.ComputeResources{
					CPU:    resource.MustParse(cpu),
					Memory: resource.MustParse("1600Mi"),
				},
				Defaults: agentzv1alpha1.AgentDefaults{
					Resources: agentzv1alpha1.ComputeResources{
						CPU:    resource.MustParse("200m"),
						Memory: resource.MustParse("400Mi"),
					},
					QoSClass: corev1.PodQOSGuaranteed,
				},
			},
		},
	}
}
