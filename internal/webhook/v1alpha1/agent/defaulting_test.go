package agent

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestDefaulterDefault(t *testing.T) {
	t.Parallel()

	agt := &agentzv1alpha1.Agent{}
	defaulter := NewDefaulter(WebhookConfig{AgentDefaultImage: "murtazau/agentz-agent:latest"})

	if err := defaulter.Default(context.Background(), agt); err != nil {
		t.Fatalf("Default() error = %v", err)
	}

	if agt.Spec.Image != "murtazau/agentz-agent:latest" {
		t.Fatalf("Image = %q", agt.Spec.Image)
	}
	if agt.Spec.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Fatalf("ImagePullPolicy = %q", agt.Spec.ImagePullPolicy)
	}
	if got := agt.Spec.NixStoreSize.String(); got != "5Gi" {
		t.Fatalf("NixStoreSize = %q", got)
	}
	if got := agt.Spec.HomeSize.String(); got != "5Gi" {
		t.Fatalf("HomeSize = %q", got)
	}
}
