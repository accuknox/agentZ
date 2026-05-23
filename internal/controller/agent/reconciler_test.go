package agent

import (
	"testing"

	ciliumapi "github.com/cilium/cilium/pkg/policy/api"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

func TestAgentEnvAddsNoProxyForTelemetryWhenSinjectorEnabled(t *testing.T) {
	t.Parallel()

	reconciler := &Reconciler{
		Config: RuntimeConfig{
			SinjectorImage:    "murtazau/clawarmor-sinjector:latest",
			AgentCABundlePath: "/etc/clawarmor/sinjector-ca/ca.crt",
		},
	}
	agt := &clawarmorv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent-proxy", Namespace: "default"},
		Spec: clawarmorv1alpha1.AgentSpec{
			Telemetry: clawarmorv1alpha1.TelemetryConfig{
				Enabled:       true,
				TraceEndpoint: "172.18.0.1:4317",
			},
		},
	}

	env := reconciler.agentEnv(agt, nil, false)
	for _, tc := range []struct {
		name string
		want string
	}{
		{name: "NO_PROXY", want: "127.0.0.1,::1,localhost,.cluster.local,.svc,172.18.0.1"},
		{name: "no_proxy", want: "127.0.0.1,::1,localhost,.cluster.local,.svc,172.18.0.1"},
	} {
		found := false
		for _, item := range env {
			if item.Name != tc.name {
				continue
			}
			found = true
			if item.Value != tc.want {
				t.Fatalf("%s = %q, want %q", tc.name, item.Value, tc.want)
			}
		}
		if !found {
			t.Fatalf("missing env var %s", tc.name)
		}
	}
}

func TestAgentEnvInjectsGatewayAndTelemetryDefaults(t *testing.T) {
	t.Parallel()

	reconciler := &Reconciler{
		Config: RuntimeConfig{
			GatewayURL: "http://gateway.default.svc.cluster.local:8090",
		},
	}
	agt := &clawarmorv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent-workflow", Namespace: "default"},
	}

	env := reconciler.agentEnv(agt, nil, false)
	for _, tc := range []struct {
		name string
		want string
	}{
		{name: "OPENCODE_ENABLE_TELEMETRY", want: "false"},
		{name: "OPENCODE_OTLP_PROTOCOL", want: "grpc"},
		{name: "OPENCODE_OTLP_ENDPOINT", want: ""},
		{name: "OPENCODE_RESOURCE_ATTRIBUTES", want: "clawarmor.agent_name=agent-workflow"},
		{name: "CLAWARMOR_GATEWAY_URL", want: "http://gateway.default.svc.cluster.local:8090"},
	} {
		found := false
		for _, item := range env {
			if item.Name != tc.name {
				continue
			}
			found = true
			if item.Value != tc.want {
				t.Fatalf("%s = %q, want %q", tc.name, item.Value, tc.want)
			}
		}
		if !found {
			t.Fatalf("missing env var %s", tc.name)
		}
	}
}

func TestBuildEgressPolicySpecAddsGatewayHost(t *testing.T) {
	t.Parallel()

	reconciler := &Reconciler{
		Config: RuntimeConfig{
			GatewayURL: "http://gateway.default.svc.cluster.local:8090",
		},
	}
	agt := &clawarmorv1alpha1.Agent{}

	spec, err := reconciler.buildEgressPolicySpec(agt, []string{"example.com"})
	if err != nil {
		t.Fatalf("buildEgressPolicySpec() error = %v", err)
	}

	var found bool
	for _, rule := range spec.Egress {
		for _, fqdn := range rule.ToFQDNs {
			if fqdn == (ciliumapi.FQDNSelector{MatchName: "gateway.default.svc.cluster.local"}) {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("gateway host missing from egress rules")
	}
}
