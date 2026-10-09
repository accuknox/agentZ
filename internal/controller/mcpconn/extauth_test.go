package mcpconn

import (
	"context"
	"slices"
	"testing"

	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"

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
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: org,
		Annotations: map[string]string{
			agentzv1alpha1.TenantOrganizationIDAnnotation: organizationID,
		},
	}}

	scheme := runtime.NewScheme()
	adders := []func(*runtime.Scheme) error{
		corev1.AddToScheme,
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
	access, err := r.workspaceAccess(context.Background(), ns)
	if err != nil {
		t.Fatalf("workspaceAccess() error = %v", err)
	}
	if len(access) != 1 || access[0].namespace != allowed.Name {
		t.Fatalf("workspaceAccess() = %#v, want only %q", access, allowed.Name)
	}

	labels := map[string]string{"app.kubernetes.io/name": extAuthLabelName}
	ownerRefs := []metav1.OwnerReference{{APIVersion: "v1", Kind: "Namespace", Name: org}}
	scope := extAuthScope{
		namespace: org, workspaces: access, labels: labels, ownerRefs: ownerRefs,
	}
	if err := r.reconcileExtAuthScopeReader(context.Background(), scope); err != nil {
		t.Fatalf("reconcileExtAuthScopeReader() error = %v", err)
	}
	if err := r.reconcileExtAuthWorkspaceAccess(context.Background(), scope); err != nil {
		t.Fatalf("reconcileExtAuthWorkspaceAccess() error = %v", err)
	}

	role := &rbacv1.ClusterRole{}
	name := mcp.ExtAuthOpenBaoName(org) + "-scope-reader"
	if err := c.Get(context.Background(), client.ObjectKey{Name: name}, role); err != nil {
		t.Fatalf("get scope reader ClusterRole: %v", err)
	}
	for _, rule := range role.Rules {
		if slices.Contains(rule.Resources, "pods") || slices.Contains(rule.Resources, "agents") {
			t.Fatalf("scope reader grants cluster-wide workload access: %#v", rule)
		}
	}

	workspaceRole := &rbacv1.Role{}
	key := client.ObjectKey{Namespace: allowed.Name, Name: mcp.ExtAuthOpenBaoName(org)}
	if err := c.Get(context.Background(), key, workspaceRole); err != nil {
		t.Fatalf("get allowed workspace Role: %v", err)
	}
	key.Namespace = foreign.Name
	err = c.Get(context.Background(), key, &rbacv1.Role{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("foreign workspace Role unexpectedly exists: %v", err)
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
	r := &ExtAuthRuntimeReconciler{Client: c, DelegationNamespace: "private", OpenBaoAddr: "http://openbao.bao.svc.cluster.local:8200"}
	scope := extAuthScope{namespace: "owner", workspaces: []workspaceAccess{{namespace: "related", mcp: true, inference: true}}}
	if err := r.reconcileExtAuthPolicy(t.Context(), scope); err != nil {
		t.Fatal(err)
	}
	policy := &ciliumv2.CiliumNetworkPolicy{}
	if err := c.Get(t.Context(), client.ObjectKey{Namespace: "owner", Name: mcp.ExtAuthServiceName}, policy); err != nil {
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
		{"unrelated inference", "foreign", "inference", "inference", false, false, false},
		{"forged local gateway labels", "owner", "untrusted", "inference", false, false, false},
		{"forged related gateway labels", "related", "untrusted", "mcp", false, false, false},
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
			expected := map[string]bool{"18081": test.ordinary, "18084": test.delegated, "18082": test.helper}
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
