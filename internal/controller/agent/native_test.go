package agent

import (
	"strings"
	"testing"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	"k8s.io/apimachinery/pkg/api/meta"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/host"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestNativeReconcileDoesNotAllocateKubernetesRuntime(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	adders := []func(*runtime.Scheme) error{
		corev1.AddToScheme, appsv1.AddToScheme, batchv1.AddToScheme,
		rbacv1.AddToScheme, agentzv1alpha1.AddToScheme,
	}
	for _, add := range adders {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	disabled := false
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "native", Namespace: "workspace", UID: "agent-uid"},
		Spec: agentzv1alpha1.AgentSpec{
			Execution: agentzv1alpha1.AgentExecutionNative, SecretProxy: &disabled,
			SandboxRef: agentzv1alpha1.ResourceReference{
				Scope: agentzv1alpha1.ResourceScopeWorkspace,
				Name:  "sandbox",
			},
		},
	}
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:   "workspace",
		Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: "workspace"},
	}}
	workspace := &agentzv1alpha1.Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace"}}
	sandbox := &agentzv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: "workspace"}}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(agt).
		WithObjects(agt, ns, workspace, sandbox).
		Build()
	r := &Reconciler{Client: c, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{
		Name: agt.Name, Namespace: agt.Namespace,
	}}
	_, err := r.Reconcile(t.Context(), request)
	if err != nil {
		t.Fatalf("native reconcile required managed image, package job or OpenBao: %v", err)
	}
	lists := []client.ObjectList{
		&appsv1.DeploymentList{}, &batchv1.JobList{}, &corev1.ServiceList{},
		&corev1.PersistentVolumeClaimList{}, &corev1.ConfigMapList{}, &corev1.SecretList{},
	}
	for _, list := range lists {
		if err := c.List(t.Context(), list); err != nil {
			t.Fatal(err)
		}
		items, err := meta.ExtractList(list)
		if err != nil {
			t.Fatal(err)
		}
		if len(items) != 0 {
			t.Errorf("unexpected managed runtime resources: %#v", items)
		}
	}
	endpoints := host.NativeEndpoints{
		MCP: "http://127.0.0.1:4181", Inference: "http://127.0.0.1:4182",
		Platform: "http://127.0.0.1:4183", ConfigDirectory: "/runtime/config",
		ImmutableSkillsDirectory: "/runtime/skills", BundledSkillsDirectory: "/runtime/core",
		WritableSkillsDirectory: "/home/user/.agents/skills",
		GatewayTokenPath:        "/runtime/token", WorkDirectory: "/home/user",
	}
	spec, err := r.NativeRuntime(t.Context(), agt, endpoints)
	if err != nil {
		t.Fatal(err)
	}
	if spec.SecretProxy || spec.Env["HTTPS_PROXY"] != "" || spec.Env["NODE_EXTRA_CA_CERTS"] != "" {
		t.Fatalf("disabled proxy still injected: %#v", spec.Env)
	}
	usesHostConfig := strings.Contains(string(spec.OpenCodeConfig), "/etc/agentz")
	usesRuntimeConfig := strings.Contains(string(spec.OpenCodeConfig), "/runtime/config/philosophy.md")
	if usesHostConfig || !usesRuntimeConfig {
		t.Fatalf("native renderer did not use runtime directory: %s", spec.OpenCodeConfig)
	}
	if spec.Env["AGENTZ_GATEWAY_URL"] != endpoints.Platform || spec.Env["AGENTZ_GATEWAY_TOKEN_PATH"] != endpoints.GatewayTokenPath {
		t.Fatalf("native platform bridge not configured: %#v", spec.Env)
	}
}

func TestSecretProxyNetworkSource(t *testing.T) {
	executions := []agentzv1alpha1.AgentExecution{
		agentzv1alpha1.AgentExecutionKubernetes,
		agentzv1alpha1.AgentExecutionNative,
	}
	for _, execution := range executions {
		t.Run(string(execution), func(t *testing.T) {
			scheme := runtime.NewScheme()
			adders := []func(*runtime.Scheme) error{
				ciliumv2.AddToScheme,
				agentzv1alpha1.AddToScheme,
			}
			for _, add := range adders {
				if err := add(scheme); err != nil {
					t.Fatal(err)
				}
			}
			agt := &agentzv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace", UID: "uid"},
				Spec:       agentzv1alpha1.AgentSpec{Execution: execution},
			}
			c := fake.NewClientBuilder().WithScheme(scheme).Build()
			r := &Reconciler{
				Client: c, Scheme: scheme,
				Config: RuntimeConfig{
					RelayServiceAccountName:      "relay",
					RelayServiceAccountNamespace: "relay-namespace",
				},
			}
			if err := r.reconcileSinjectorPolicy(t.Context(), agt, nil); err != nil {
				t.Fatal(err)
			}
			var policy ciliumv2.CiliumNetworkPolicy
			key := client.ObjectKey{Name: sinjectorName(agt), Namespace: agt.Namespace}
			if err := c.Get(t.Context(), key, &policy); err != nil {
				t.Fatal(err)
			}
			labels := policy.Spec.Ingress[0].FromEndpoints[0].MatchLabels
			wantNamespace, wantAccount := "workspace", "agent"
			if execution == agentzv1alpha1.AgentExecutionNative {
				wantNamespace, wantAccount = "relay-namespace", "relay"
				if len(labels) != 2 {
					t.Fatalf("unexpected native source labels: %v", labels)
				}
			}
			namespaceMatches := labels["k8s:io.kubernetes.pod.namespace"] == wantNamespace
			accountMatches := labels["k8s:io.cilium.k8s.policy.serviceaccount"] == wantAccount
			if !namespaceMatches || !accountMatches {
				t.Fatalf("wrong caller identity: %v", labels)
			}
			if execution == agentzv1alpha1.AgentExecutionNative {
				r.Config.RelayServiceAccountNamespace = ""
				if err := r.reconcileSinjectorPolicy(t.Context(), agt, nil); err == nil {
					t.Fatal("missing relay namespace must fail closed")
				}
			}
		})
	}
}
