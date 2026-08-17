package extauth

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestLookupAgentPodByIPSearchesOnlyAuthorizedNamespaces(t *testing.T) {
	t.Parallel()

	allowed := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "allowed-agent",
			Namespace: "workspace-a",
			Labels: map[string]string{
				managedLabelKey: managedLabelValue,
				appNameLabelKey: appNameAgent,
			},
		},
		Status: corev1.PodStatus{PodIP: "10.0.0.2"},
	}
	foreign := allowed.DeepCopy()
	foreign.Name = "foreign-agent"
	foreign.Namespace = "workspace-b"

	kube := fake.NewSimpleClientset(allowed, foreign)
	svc := &Service{
		sourceNamespaces: []string{"organization-a", "workspace-a"},
		kubeCore:         kube,
	}
	pod, err := svc.lookupAgentPodByIP(context.Background(), allowed.Status.PodIP)
	if err != nil {
		t.Fatalf("lookupAgentPodByIP() error = %v", err)
	}
	if pod.Namespace != allowed.Namespace || pod.Name != allowed.Name {
		t.Fatalf("lookupAgentPodByIP() = %s/%s, want %s/%s", pod.Namespace, pod.Name, allowed.Namespace, allowed.Name)
	}

	for _, action := range kube.Actions() {
		if action.GetNamespace() == foreign.Namespace {
			t.Fatalf("lookup read foreign namespace %q", foreign.Namespace)
		}
	}
}
