//go:build integration

package mcpconn

import (
	"os"
	"testing"

	sandboxcontroller "github.com/accuknox/agentz/internal/controller/sandbox"
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/config"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// TestLiveDelegationRuntime applies the production runtime reconciler to an
// explicitly named disposable namespace. It requires pre-existing grant routes.
func TestLiveDelegationRuntime(t *testing.T) {
	ns := os.Getenv("AGENTZ_E2E_NAMESPACE")
	if ns == "" {
		t.Skip("set AGENTZ_E2E_NAMESPACE to a disposable namespace")
	}
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, gwv1.Install, agw.Install, ciliumv2.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	owner := &corev1.Namespace{}
	if err := c.Get(t.Context(), client.ObjectKey{Name: ns}, owner); err != nil {
		t.Fatal(err)
	}
	if owner.Labels["agentz.accuknox.com/e2e-external-agents"] != "true" {
		t.Fatal("namespace must be explicitly labeled agentz.accuknox.com/e2e-external-agents=true")
	}
	if os.Getenv("AGENTZ_E2E_TRACE_HOST") == "" {
		t.Fatal("set AGENTZ_E2E_TRACE_HOST to the test OTLP receiver")
	}
	r := &ExtAuthRuntimeReconciler{Client: c, TraceBackend: sandboxcontroller.TraceBackend{Mode: sandboxcontroller.TraceBackendModeStatic, Host: os.Getenv("AGENTZ_E2E_TRACE_HOST"), Port: 4317}}
	if err := r.reconcileDelegationRuntime(t.Context(), owner); err != nil {
		t.Fatal(err)
	}
}
