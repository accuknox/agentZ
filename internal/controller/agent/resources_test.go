package agent

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestBuildDeploymentAssignsCPUAndMemoryToPod(t *testing.T) {
	t.Parallel()

	gpu := corev1.ResourceName("example.com/gpu")
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
		Spec: agentzv1alpha1.AgentSpec{
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("500m"),
					corev1.ResourceMemory: resource.MustParse("800Mi"),
					gpu:                   resource.MustParse("1"),
				},
				Limits: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("500m"),
					corev1.ResourceMemory: resource.MustParse("800Mi"),
					gpu:                   resource.MustParse("1"),
				},
			},
		},
	}

	deployment := (&Reconciler{}).buildDeployment(agt, "hash", sandboxConfig{}, false)
	podResources := deployment.Spec.Template.Spec.Resources
	if podResources == nil {
		t.Fatal("Pod resources are nil")
	}
	if got := podResources.Requests[corev1.ResourceCPU]; got.Cmp(resource.MustParse("500m")) != 0 {
		t.Errorf("Pod CPU request = %s, want 500m", got.String())
	}
	if got := podResources.Limits[corev1.ResourceMemory]; got.Cmp(resource.MustParse("800Mi")) != 0 {
		t.Errorf("Pod memory limit = %s, want 800Mi", got.String())
	}
	containerResources := deployment.Spec.Template.Spec.Containers[0].Resources
	if _, ok := containerResources.Requests[corev1.ResourceCPU]; ok {
		t.Error("main container retained CPU request")
	}
	if got := containerResources.Requests[gpu]; got.Cmp(resource.MustParse("1")) != 0 {
		t.Errorf("main container GPU request = %s, want 1", got.String())
	}
}
