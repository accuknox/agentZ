package agent

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

func TestDefaulterDefault(t *testing.T) {
	t.Parallel()

	agt := &clawarmorv1alpha1.Agent{}
	defaulter := NewDefaulter(WebhookConfig{AgentDefaultImage: "murtazau/clawarmor-agent:latest"})

	if err := defaulter.Default(context.Background(), agt); err != nil {
		t.Fatalf("Default() error = %v", err)
	}

	if agt.Spec.Image != "murtazau/clawarmor-agent:latest" {
		t.Fatalf("Image = %q", agt.Spec.Image)
	}
	if agt.Spec.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Fatalf("ImagePullPolicy = %q", agt.Spec.ImagePullPolicy)
	}
	if got := agt.Spec.NixStoreSize.String(); got != "5Gi" {
		t.Fatalf("NixStoreSize = %q", got)
	}
}
