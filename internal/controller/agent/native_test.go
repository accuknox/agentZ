package agent

import (
	"strings"
	"testing"

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

	"github.com/accuknox/agentz/internal/compute"
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
			SandboxRef: agentzv1alpha1.ResourceReference{Scope: agentzv1alpha1.ResourceScopeWorkspace, Name: "sandbox"},
		},
	}
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:   "workspace",
		Labels: map[string]string{agentzv1alpha1.WorkspaceNameLabel: "workspace"},
	}}
	workspace := &agentzv1alpha1.Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace"}}
	sandbox := &agentzv1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: "workspace"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(agt).WithObjects(agt, ns, workspace, sandbox).Build()
	r := &Reconciler{Client: c, Scheme: scheme}
	_, err := r.Reconcile(t.Context(), ctrl.Request{NamespacedName: types.NamespacedName{Name: agt.Name, Namespace: agt.Namespace}})
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
	endpoints := compute.NativeEndpoints{
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
	if strings.Contains(string(spec.OpenCodeConfig), "/etc/agentz") || !strings.Contains(string(spec.OpenCodeConfig), "/runtime/config/philosophy.md") {
		t.Fatalf("native renderer did not use runtime directory: %s", spec.OpenCodeConfig)
	}
	if spec.Env["AGENTZ_GATEWAY_URL"] != endpoints.Platform || spec.Env["AGENTZ_GATEWAY_TOKEN_PATH"] != endpoints.GatewayTokenPath {
		t.Fatalf("native platform bridge not configured: %#v", spec.Env)
	}
}
