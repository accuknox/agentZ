package mcpconn

import (
	"slices"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/accuknox/agentz/internal/authorization"
	sandboxcontroller "github.com/accuknox/agentz/internal/controller/sandbox"
	"github.com/accuknox/agentz/internal/inference"
	"github.com/accuknox/agentz/internal/mcp"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestExtAuthAccessIsLimitedToOrganizationWorkspaces(t *testing.T) {
	t.Parallel()

	const organizationID = "organization-a"
	org := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	allowed := workspaceForExtAuth("workspace-a", organizationID)
	allowed.Spec.SelectedOrganizationResources.MCPConnections = []string{"mcp-a"}
	foreign := workspaceForExtAuth("workspace-b", "organization-b")
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   org,
			Labels: map[string]string{agentzv1alpha1.TenantNameLabel: org},
			Annotations: map[string]string{
				agentzv1alpha1.TenantOrganizationIDAnnotation: organizationID,
			},
		},
	}

	scheme := runtime.NewScheme()
	adders := []func(*runtime.Scheme) error{
		corev1.AddToScheme,
		appsv1.AddToScheme,
		rbacv1.AddToScheme,
		gwv1.Install,
		agentzv1alpha1.AddToScheme,
	}
	for _, add := range adders {
		if err := add(scheme); err != nil {
			t.Fatalf("add scheme: %v", err)
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(ns, allowed, foreign).Build()
	r := &ExtAuthRuntimeReconciler{Client: c}
	access, err := r.workspaceAccess(t.Context(), ns)
	if err != nil {
		t.Fatalf("workspaceAccess() error = %v", err)
	}
	if len(access) != 1 || access[0].namespace != allowed.Name {
		t.Fatalf("workspaceAccess() = %#v, want only %q", access, allowed.Name)
	}

	labels := map[string]string{
		"app.kubernetes.io/name":       extAuthLabelName,
		"app.kubernetes.io/managed-by": "agentz-extauth-controller",
	}
	ownerRefs := []metav1.OwnerReference{{APIVersion: "v1", Kind: "Namespace", Name: org}}
	scope := extAuthScope{
		namespace:  org,
		workspaces: access,
		labels:     labels,
		ownerRefs:  ownerRefs,
	}
	if err := r.reconcileExtAuthScopeReader(t.Context(), scope); err != nil {
		t.Fatalf("reconcileExtAuthScopeReader() error = %v", err)
	}
	if err := r.reconcileExtAuthWorkspaceAccess(t.Context(), scope); err != nil {
		t.Fatalf("reconcileExtAuthWorkspaceAccess() error = %v", err)
	}

	role := &rbacv1.ClusterRole{}
	name := mcp.ExtAuthOpenBaoName(org) + "-scope-reader"
	if err := c.Get(t.Context(), client.ObjectKey{Name: name}, role); err != nil {
		t.Fatalf("get scope reader ClusterRole: %v", err)
	}
	for _, rule := range role.Rules {
		if slices.Contains(rule.Resources, "pods") || slices.Contains(rule.Resources, "agents") {
			t.Fatalf("scope reader grants cluster-wide workload access: %#v", rule)
		}
	}

	workspaceRole := &rbacv1.Role{}
	key := client.ObjectKey{Namespace: allowed.Name, Name: mcp.ExtAuthOpenBaoName(org)}
	if err := c.Get(t.Context(), key, workspaceRole); err != nil {
		t.Fatalf("get allowed workspace Role: %v", err)
	}
	key.Namespace = foreign.Name
	err = c.Get(t.Context(), key, &rbacv1.Role{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("foreign workspace Role unexpectedly exists: %v", err)
	}
	guardrailKey := client.ObjectKey{Namespace: org, Name: name + "-guardrails"}
	guardrailRole := &rbacv1.Role{}
	if err := c.Get(t.Context(), guardrailKey, guardrailRole); err != nil {
		t.Fatal(err)
	}
	if len(guardrailRole.OwnerReferences) != 1 || guardrailRole.OwnerReferences[0].Name != org {
		t.Fatal("guardrail access must follow the runtime namespace lifecycle")
	}
	if err := r.deleteExtAuthRuntime(t.Context(), org); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{&rbacv1.Role{}, &rbacv1.RoleBinding{}}
	for _, object := range objects {
		if err := c.Get(t.Context(), guardrailKey, object); !apierrors.IsNotFound(err) {
			t.Fatalf("disabled runtime retained guardrail access %T: %v", object, err)
		}
	}
}

func workspaceForExtAuth(id, organizationID string) *agentzv1alpha1.Workspace {
	name := agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeWorkspace, id)
	return &agentzv1alpha1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: name, UID: types.UID("uid-" + name)},
		Spec: agentzv1alpha1.WorkspaceSpec{
			WorkspaceID:    id,
			OrganizationID: organizationID,
		},
	}
}

type extAuthCallerCase struct {
	name, namespace, account, gateway string
	ordinary, delegated, helper       bool
}

func TestExtAuthCallerIdentities(t *testing.T) {
	scheme := runtime.NewScheme()
	registrations := []func(*runtime.Scheme) error{agentzv1alpha1.AddToScheme, ciliumv2.AddToScheme}
	for _, add := range registrations {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	r := &ExtAuthRuntimeReconciler{
		Client:              c,
		DelegationNamespace: "private",
		OpenBaoAddr:         "http://openbao.bao.svc.cluster.local:8200",
	}
	scope := extAuthScope{
		namespace: "owner",
		workspaces: []workspaceAccess{{
			namespace: "related",
			mcp:       true,
			inference: true,
		}},
	}
	if err := r.reconcileExtAuthPolicy(t.Context(), scope); err != nil {
		t.Fatal(err)
	}
	policy := &ciliumv2.CiliumNetworkPolicy{}
	key := client.ObjectKey{Namespace: "owner", Name: mcp.ExtAuthServiceName}
	if err := c.Get(t.Context(), key, policy); err != nil {
		t.Fatal(err)
	}
	if err := policy.Spec.Sanitize(); err != nil {
		t.Fatal(err)
	}
	cases := []extAuthCallerCase{
		{"local inference", "owner", "inference", "inference", true, true, false},
		{"local MCP", "owner", "mcp", "mcp", true, true, true},
		{"related inference", "related", "inference", "inference", true, false, false},
		{"related MCP", "related", "mcp", "mcp", true, false, true},
		{
			"unrelated inference",
			"foreign",
			"inference",
			"inference",
			false,
			false,
			false,
		},
		{
			"forged local gateway labels",
			"owner",
			"untrusted",
			"inference",
			false,
			false,
			false,
		},
		{
			"forged related gateway labels",
			"related",
			"untrusted",
			"mcp",
			false,
			false,
			false,
		},
		{"aggregator", "private", "delegations", "delegations", false, false, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			identity := labels.Set{
				"k8s.io.kubernetes.pod.namespace":            test.namespace,
				"k8s.io.cilium.k8s.policy.serviceaccount":    test.account,
				"k8s.gateway.networking.k8s.io/gateway-name": test.gateway,
				"k8s.app.kubernetes.io/name":                 test.gateway,
			}
			expected := map[string]bool{
				"18081": test.ordinary,
				"18084": test.delegated,
				"18082": test.helper,
			}
			for port, want := range expected {
				admitted := false
				for _, rule := range policy.Spec.Ingress {
					for _, source := range rule.FromEndpoints {
						selector, err := slimv1.LabelSelectorAsSelector(source.LabelSelector)
						if err != nil {
							t.Fatal(err)
						}
						if !selector.Matches(identity) {
							continue
						}
						for _, ports := range rule.ToPorts {
							for _, destination := range ports.Ports {
								admitted = admitted || destination.Port == port
							}
						}
					}
				}
				if admitted != want {
					t.Fatalf("credential admission on %s = %v, want %v", port, admitted, want)
				}
			}
		})
	}
}

func TestDelegationPreservesAgentGatewayParameters(t *testing.T) {
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, gwv1.Install, agw.Install, ciliumv2.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	namespace := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: "telemetry-test", UID: "namespace-uid"},
	}
	normal := &gwv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace.Name, Name: "agent-route"},
		Spec: gwv1.HTTPRouteSpec{
			CommonRouteSpec: gwv1.CommonRouteSpec{
				ParentRefs: []gwv1.ParentReference{{Name: gwv1.ObjectName(inference.GatewayName)}},
			},
		},
	}
	delegated := normal.DeepCopy()
	delegated.Name = "app-route"
	delegated.Labels = map[string]string{authorization.DelegationLabel: "grant"}
	gateway := inference.Gateway(namespace.Name)
	originalImage := &agw.Image{
		Registry:   new("registry.example.test"),
		Repository: new("gateway"),
		Tag:        new("operator"),
	}
	parameters := &agw.AgentgatewayParameters{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace.Name,
			Name:      gateway.Spec.Infrastructure.ParametersRef.Name,
		},
		Spec: agw.AgentgatewayParametersSpec{
			Image: originalImage,
			Env: []corev1.EnvVar{
				{Name: "OPERATOR_VARIABLE", Value: "keep"},
				{Name: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", Value: "32"},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(namespace, normal, delegated, parameters).Build()
	r := &ExtAuthRuntimeReconciler{
		Client: c,
		TraceBackend: sandboxcontroller.TraceBackend{
			Mode: sandboxcontroller.TraceBackendModeStatic,
			Host: "192.0.2.10",
			Port: 4317,
		},
	}
	if err := r.reconcileDelegationRuntime(t.Context(), namespace); err != nil {
		t.Fatal(err)
	}
	key := client.ObjectKeyFromObject(parameters)
	if err := c.Get(t.Context(), key, parameters); err != nil {
		t.Fatal(err)
	}
	if !equality.Semantic.DeepEqual(parameters.Spec.Image, originalImage) {
		t.Fatal("delegation changed the operator's image")
	}
	if len(parameters.Spec.Env) != 2 || parameters.Spec.Env[1].Value != "1" {
		t.Fatalf("full-content exports were not isolated into one-span batches: %+v", parameters.Spec.Env)
	}
	// Operator changes during delegation must survive revocation.
	parameters.Spec.Image.Tag = new("updated")
	if err := c.Update(t.Context(), parameters); err != nil {
		t.Fatal(err)
	}
	originalImage.Tag = new("updated")
	if err := c.Delete(t.Context(), delegated); err != nil {
		t.Fatal(err)
	}
	if err := r.reconcileDelegationRuntime(t.Context(), namespace); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(t.Context(), key, parameters); err != nil {
		t.Fatal(err)
	}
	restored := equality.Semantic.DeepEqual(parameters.Spec.Image, originalImage) &&
		len(parameters.Spec.Env) == 2 && parameters.Spec.Env[1].Value == "32" &&
		parameters.Spec.Env[0].Value == "keep"
	if !restored {
		t.Fatalf("final app removal changed Agent settings: %+v", parameters.Spec)
	}
	if _, ok := parameters.Annotations[delegationParametersAnnotation]; ok {
		t.Fatal("obsolete delegation settings snapshot retained")
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(gateway), gateway); err != nil {
		t.Fatal(err)
	}
	for _, listener := range gateway.Spec.Listeners {
		if listener.Name == "delegation" {
			t.Fatal("delegation listener retained after final grant removal")
		}
	}
	if len(gateway.Spec.Listeners) == 0 {
		t.Fatal("Agent listener was removed")
	}
	policy := &agw.AgentgatewayPolicy{}
	key = client.ObjectKey{
		Namespace: namespace.Name,
		Name:      inference.GatewayName + "-delegation-tracing",
	}
	err := c.Get(t.Context(), key, policy)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("delegation tracing retained: %v", err)
	}
}
