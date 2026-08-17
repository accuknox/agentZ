//go:build controller

package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	cmapi "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
	cmmeta "github.com/cert-manager/cert-manager/pkg/apis/meta/v1"
	cmfake "github.com/cert-manager/cert-manager/pkg/client/clientset/versioned/fake"
	ciliumclient "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/client"
	ciliumv2 "github.com/cilium/cilium/pkg/k8s/apis/cilium.io/v2"
	slimv1 "github.com/cilium/cilium/pkg/k8s/slim/k8s/apis/meta/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/networkpolicy"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const managerToken = "workspace-controller-token"

type lifecycleCall struct {
	Authorization   string
	Body            gatewayapi.UpdateWorkspaceLifecycleRequest
	TenantNamespace string
	WorkspaceID     string
}

type lifecycleRecorder struct {
	mu       sync.Mutex
	calls    []lifecycleCall
	statuses []int
}

var (
	testClient client.Client
	testEnv    *envtest.Environment
	testScheme = runtime.NewScheme()
)

func TestMain(m *testing.M) {
	utilruntime.Must(corev1.AddToScheme(testScheme))
	utilruntime.Must(rbacv1.AddToScheme(testScheme))
	utilruntime.Must(ciliumv2.AddToScheme(testScheme))
	utilruntime.Must(agentzv1alpha1.AddToScheme(testScheme))
	cnpCRD := ciliumclient.GetPregeneratedCRD(
		slog.Default(),
		ciliumclient.CNPCRDName,
	)

	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "..", "deploy", "kustomize", "crd", "bases")},
		CRDs:                  []*apiextensionsv1.CustomResourceDefinition{&cnpCRD},
		ErrorIfCRDPathMissing: true,
	}
	cfg, err := testEnv.Start()
	if err != nil {
		panic(fmt.Sprintf("start envtest: %v", err))
	}
	testClient, err = client.New(cfg, client.Options{Scheme: testScheme})
	if err != nil {
		panic(fmt.Sprintf("create envtest client: %v", err))
	}

	code := m.Run()
	if err := testEnv.Stop(); err != nil && code == 0 {
		fmt.Fprintf(os.Stderr, "stop envtest: %v\n", err)
		code = 1
	}
	os.Exit(code)
}

func TestReconcileCreatesDeterministicWorkspaceNamespace(t *testing.T) {
	organizationID := "org-workspace-success"
	workspaceID := "workspace-success"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcileUntilReady(t, reconciler, workspace.Name)

	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateReady {
		t.Fatalf("state = %q, want %q", current.Status.State, agentzv1alpha1.WorkspaceStateReady)
	}
	if current.Status.ObservedAttempt != 1 {
		t.Fatalf("observed attempt = %d, want 1", current.Status.ObservedAttempt)
	}
	if !apimeta.IsStatusConditionTrue(current.Status.Conditions, agentzv1alpha1.WorkspaceConditionReady) {
		t.Fatal("Ready condition is not true")
	}

	var ns corev1.Namespace
	if err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &ns); err != nil {
		t.Fatalf("get workspace namespace: %v", err)
	}
	tenantName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	if got := ns.Labels[agentzv1alpha1.WorkspaceNameLabel]; got != workspace.Name {
		t.Errorf("workspace label = %q, want %q", got, workspace.Name)
	}
	if got := ns.Labels[agentzv1alpha1.TenantOrganizationIDLabel]; got != tenantName {
		t.Errorf("organization label = %q, want %q", got, tenantName)
	}
	if got := ns.Annotations[agentzv1alpha1.WorkspaceIDAnnotation]; got != workspaceID {
		t.Errorf("workspace annotation = %q, want %q", got, workspaceID)
	}
	if got := ns.Annotations[agentzv1alpha1.TenantOrganizationIDAnnotation]; got != organizationID {
		t.Errorf("organization annotation = %q, want %q", got, organizationID)
	}
	if !metav1.IsControlledBy(&ns, workspace) {
		t.Fatal("workspace is not the namespace controller owner")
	}
	var policy ciliumv2.CiliumNetworkPolicy
	err := testClient.Get(
		context.Background(),
		client.ObjectKey{
			Name:      agentzv1alpha1.WorkspaceIsolationPolicyName,
			Namespace: workspace.Name,
		},
		&policy,
	)
	if err != nil {
		t.Fatalf("get workspace isolation policy: %v", err)
	}
	if !metav1.IsControlledBy(&policy, workspace) {
		t.Fatal("workspace is not the isolation policy controller owner")
	}
	selector := policy.Spec.EndpointSelector.LabelSelector
	if selector == nil || len(selector.MatchExpressions) != 1 {
		t.Fatalf("baseline selector = %#v, want one expression", selector)
	}
	expression := selector.MatchExpressions[0]
	keyMatches := expression.Key == "k8s:"+agentzv1alpha1.AgentPackageJobLabel
	if !keyMatches || expression.Operator != slimv1.LabelSelectorOpDoesNotExist {
		t.Fatalf("baseline selector = %#v, want package jobs excluded", selector)
	}

	var pvc corev1.PersistentVolumeClaim
	err = testClient.Get(
		context.Background(),
		client.ObjectKey{Name: "nix-store", Namespace: workspace.Name},
		&pvc,
	)
	if err != nil {
		t.Fatalf("get workspace nix store pvc: %v", err)
	}
	if !metav1.IsControlledBy(&pvc, workspace) {
		t.Fatal("workspace is not the nix store PVC controller owner")
	}
	if got := pvc.Labels[agentzv1alpha1.WorkspaceNameLabel]; got != workspace.Name {
		t.Errorf("PVC workspace label = %q, want %q", got, workspace.Name)
	}
	if got := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; got.Cmp(resource.MustParse("1Gi")) != 0 {
		t.Errorf("PVC storage = %s, want 1Gi", got.String())
	}

	err = testClient.Get(
		context.Background(),
		client.ObjectKey{
			Name:      agentzv1alpha1.WorkspacePackagePolicyName,
			Namespace: workspace.Name,
		},
		&policy,
	)
	if err != nil {
		t.Fatalf("get workspace package policy: %v", err)
	}
	if !metav1.IsControlledBy(&policy, workspace) {
		t.Fatal("workspace is not the package policy controller owner")
	}
	selector = policy.Spec.EndpointSelector.LabelSelector
	if selector == nil || len(selector.MatchExpressions) != 1 {
		t.Fatalf("package selector = %#v, want one expression", selector)
	}
	expression = selector.MatchExpressions[0]
	keyMatches = expression.Key == "k8s:"+agentzv1alpha1.AgentPackageJobLabel
	if !keyMatches || expression.Operator != slimv1.LabelSelectorOpExists {
		t.Fatalf("package selector = %#v, want only package jobs", selector)
	}
	ingressDenied := policy.Spec.EnableDefaultDeny.Ingress != nil && *policy.Spec.EnableDefaultDeny.Ingress
	egressDenied := policy.Spec.EnableDefaultDeny.Egress != nil && *policy.Spec.EnableDefaultDeny.Egress
	if !ingressDenied || !egressDenied {
		t.Fatalf("package default deny = %#v, want ingress and egress", policy.Spec.EnableDefaultDeny)
	}
	wantTargets := map[string]string{
		"cache.nixos.org":                 "443",
		"rustfs.rustfs.svc.cluster.local": "9000",
	}
	for _, rule := range policy.Spec.Egress {
		oneFQDN := len(rule.ToFQDNs) == 1
		onePortRule := len(rule.ToPorts) == 1
		if !oneFQDN || !onePortRule || len(rule.ToPorts[0].Ports) != 1 {
			continue
		}
		host := rule.ToFQDNs[0].MatchName
		if wantTargets[host] != rule.ToPorts[0].Ports[0].Port {
			t.Fatalf("package egress target %q:%q is not configured", host, rule.ToPorts[0].Ports[0].Port)
		}
		delete(wantTargets, host)
	}
	if len(wantTargets) != 0 {
		t.Fatalf("missing package egress targets: %v", wantTargets)
	}

	calls := recorder.Calls()
	if len(calls) != 1 {
		t.Fatalf("lifecycle calls = %d, want 1", len(calls))
	}
	assertLifecycleCall(
		t,
		calls[0],
		workspaceID,
		tenantName,
		1,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateReady,
	)
}

func TestReconcileRetriesUnavailableTenantWithoutFailingAttempt(t *testing.T) {
	organizationID := "org-workspace-failure"
	workspaceID := "workspace-failure"
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)

	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateProvisioning {
		t.Fatalf("state = %q, want %q", current.Status.State, agentzv1alpha1.WorkspaceStateProvisioning)
	}
	ready := apimeta.FindStatusCondition(
		current.Status.Conditions,
		agentzv1alpha1.WorkspaceConditionReady,
	)
	if ready == nil || ready.Reason != agentzv1alpha1.WorkspaceReasonTenantUnavailable {
		t.Fatalf("Ready reason = %v, want TenantUnavailable", ready)
	}
	if strings.Contains(ready.Message, current.Name) {
		t.Fatalf("public status leaks a resource name: %q", ready.Message)
	}
	var ns corev1.Namespace
	err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &ns)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("get failed workspace namespace error = %v, want not found", err)
	}

	if calls := recorder.Calls(); len(calls) != 0 {
		t.Fatalf("lifecycle calls = %d, want 0", len(calls))
	}

	createReadyTenant(t, organizationID)
	reconcileUntilReady(t, reconciler, workspace.Name)
	current = getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateReady {
		t.Fatalf("state after retry = %q, want Ready", current.Status.State)
	}
	if calls := recorder.Calls(); len(calls) != 1 {
		t.Fatalf("lifecycle calls after retry = %d, want 1", len(calls))
	}
}

func TestReconcileRejectsConflictingPackageStorageWithoutLeakingIdentity(t *testing.T) {
	organizationID := "org-workspace-storage-conflict"
	workspaceID := "workspace-storage-conflict"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)
	var pvc corev1.PersistentVolumeClaim
	key := client.ObjectKey{Name: "nix-store", Namespace: workspace.Name}
	if err := testClient.Get(context.Background(), key, &pvc); err != nil {
		t.Fatalf("get workspace nix store pvc: %v", err)
	}
	pvc.Labels[agentzv1alpha1.WorkspaceNameLabel] = "foreign-workspace-secret"
	if err := testClient.Update(context.Background(), &pvc); err != nil {
		t.Fatalf("corrupt workspace nix store identity: %v", err)
	}

	reconcile(t, reconciler, workspace.Name)
	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateFailed {
		t.Fatalf("state = %q, want Failed", current.Status.State)
	}
	degraded := apimeta.FindStatusCondition(
		current.Status.Conditions,
		agentzv1alpha1.WorkspaceConditionDegraded,
	)
	if degraded == nil || degraded.Reason != agentzv1alpha1.WorkspaceReasonStorageInvalid {
		t.Fatalf("Degraded reason = %v, want StorageInvalid", degraded)
	}
	if strings.Contains(degraded.Message, "foreign-workspace-secret") {
		t.Fatalf("public status leaks the conflicting identity: %q", degraded.Message)
	}
	calls := recorder.Calls()
	if len(calls) != 1 || calls[0].Body.State != gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed {
		t.Fatalf("lifecycle calls = %#v, want one Failed callback", calls)
	}
}

func TestReconcileRejectsConflictingNamespaceWithoutLeakingIdentity(t *testing.T) {
	organizationID := "org-workspace-retry"
	workspaceID := "workspace-retry"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: workspace.Name,
			Labels: map[string]string{
				agentzv1alpha1.TenantManagedByLabel:      agentzv1alpha1.TenantManagedByValue,
				agentzv1alpha1.WorkspaceNameLabel:        workspace.Name,
				agentzv1alpha1.TenantOrganizationIDLabel: agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeOrganisation, organizationID),
			},
			Annotations: map[string]string{
				agentzv1alpha1.WorkspaceIDAnnotation:          "foreign-workspace-secret",
				agentzv1alpha1.TenantOrganizationIDAnnotation: organizationID,
			},
		},
	}
	if err := testClient.Create(context.Background(), ns); err != nil {
		t.Fatalf("create conflicting namespace: %v", err)
	}
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)

	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateFailed {
		t.Fatalf("state = %q, want Failed", current.Status.State)
	}
	degraded := apimeta.FindStatusCondition(
		current.Status.Conditions,
		agentzv1alpha1.WorkspaceConditionDegraded,
	)
	if degraded == nil || degraded.Reason != agentzv1alpha1.WorkspaceReasonNamespaceConflict {
		t.Fatalf("Degraded reason = %v, want NamespaceConflict", degraded)
	}
	if strings.Contains(degraded.Message, "foreign-workspace-secret") {
		t.Fatalf("public status leaks the conflicting identity: %q", degraded.Message)
	}

	calls := recorder.Calls()
	if len(calls) != 1 {
		t.Fatalf("lifecycle calls = %d, want 1", len(calls))
	}
	if calls[0].Body.State != gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed {
		t.Fatalf("lifecycle state = %q, want Failed", calls[0].Body.State)
	}
	failureReason := calls[0].Body.FailureReason
	if failureReason == nil {
		t.Fatal("lifecycle failure reason is missing")
	}
	if strings.Contains(*failureReason, "foreign-workspace-secret") {
		t.Fatalf("unsafe lifecycle failure reason: %q", *failureReason)
	}

	err := testClient.Get(
		context.Background(),
		client.ObjectKey{Name: workspace.Name},
		ns,
	)
	if err != nil {
		t.Fatalf("get conflicting namespace: %v", err)
	}
	delete(ns.Annotations, agentzv1alpha1.WorkspaceIDAnnotation)
	ns.Annotations[agentzv1alpha1.WorkspaceIDAnnotation] = workspaceID
	if err := testClient.Update(context.Background(), ns); err != nil {
		t.Fatalf("repair conflicting namespace: %v", err)
	}
	reconcile(t, reconciler, workspace.Name)
	markIsolationPolicyValid(t, workspace.Name)
	reconcile(t, reconciler, workspace.Name)
	markCertificateReady(t, reconciler, workspace.Name)
	reconcile(t, reconciler, workspace.Name)
	current = getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateFailed {
		t.Fatalf("state after repair = %q, want Failed until retry", current.Status.State)
	}
	if calls := recorder.Calls(); len(calls) != 2 {
		t.Fatalf("lifecycle calls after repair = %d, want 2", len(calls))
	}

	current.Spec.ProvisioningAttempt++
	if err := testClient.Update(context.Background(), current); err != nil {
		t.Fatalf("increment provisioning attempt: %v", err)
	}
	reconcile(t, reconciler, workspace.Name)
	current = getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateReady {
		t.Fatalf("state after retry = %q, want Ready", current.Status.State)
	}
	calls = recorder.Calls()
	if len(calls) != 3 {
		t.Fatalf("lifecycle calls after retry = %d, want 3", len(calls))
	}
	assertLifecycleCall(
		t,
		calls[2],
		workspaceID,
		agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			organizationID,
		),
		2,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateReady,
	)
}

func TestReconcileReplaysFailedLifecycleAfterCallbackFailure(t *testing.T) {
	organizationID := "org-workspace-failed-callback"
	workspaceID := "workspace-failed-callback"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: workspace.Name}}
	if err := testClient.Create(context.Background(), ns); err != nil {
		t.Fatalf("create unmarked namespace: %v", err)
	}
	recorder := &lifecycleRecorder{statuses: []int{http.StatusInternalServerError}}
	reconciler := newTestReconciler(t, recorder)

	_, err := reconciler.Reconcile(
		context.Background(),
		ctrl.Request{NamespacedName: client.ObjectKey{Name: workspace.Name}},
	)
	if err == nil {
		t.Fatal("first reconcile error = nil, want gateway status error")
	}
	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateFailed {
		t.Fatalf("state after callback failure = %q, want Failed", current.Status.State)
	}

	var stored corev1.Namespace
	if err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &stored); err != nil {
		t.Fatalf("get unmarked namespace: %v", err)
	}
	stored.Labels = map[string]string{
		agentzv1alpha1.TenantManagedByLabel:      agentzv1alpha1.TenantManagedByValue,
		agentzv1alpha1.WorkspaceNameLabel:        workspace.Name,
		agentzv1alpha1.TenantOrganizationIDLabel: agentzv1alpha1.ScopeNamespace(agentzv1alpha1.ResourceScopeOrganisation, organizationID),
	}
	stored.Annotations = map[string]string{
		agentzv1alpha1.WorkspaceIDAnnotation:          workspaceID,
		agentzv1alpha1.TenantOrganizationIDAnnotation: organizationID,
	}
	if err := testClient.Update(context.Background(), &stored); err != nil {
		t.Fatalf("mark namespace for adoption: %v", err)
	}
	reconcile(t, reconciler, workspace.Name)
	markIsolationPolicyValid(t, workspace.Name)
	reconcile(t, reconciler, workspace.Name)
	markCertificateReady(t, reconciler, workspace.Name)
	reconcile(t, reconciler, workspace.Name)

	if calls := recorder.Calls(); len(calls) != 2 {
		t.Fatalf("lifecycle calls = %d, want failed callback replay", len(calls))
	}
}

func TestReconcileRetriesTerminalGatewayObservation(t *testing.T) {
	organizationID := "org-workspace-gateway-retry"
	workspaceID := "workspace-gateway-retry"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{statuses: []int{http.StatusInternalServerError}}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)
	markIsolationPolicyValid(t, workspace.Name)
	reconcile(t, reconciler, workspace.Name)
	markCertificateReady(t, reconciler, workspace.Name)
	_, err := reconciler.Reconcile(
		context.Background(),
		ctrl.Request{NamespacedName: client.ObjectKey{Name: workspace.Name}},
	)
	if err == nil {
		t.Fatal("first reconcile error = nil, want gateway status error")
	}
	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateReady {
		t.Fatalf("state after callback failure = %q, want Ready", current.Status.State)
	}

	reconcile(t, reconciler, workspace.Name)
	if calls := recorder.Calls(); len(calls) != 2 {
		t.Fatalf("lifecycle calls = %d, want 2", len(calls))
	}
}

func TestProvisioningAttemptCannotDecrease(t *testing.T) {
	workspace := createWorkspace(
		t,
		"org-workspace-monotonic-attempt",
		"workspace-monotonic-attempt",
		2,
	)
	workspace.Spec.ProvisioningAttempt = 1
	err := testClient.Update(context.Background(), workspace)
	if !apierrors.IsInvalid(err) {
		t.Fatalf("decrease provisioning attempt error = %v, want invalid", err)
	}
}

func (r *lifecycleRecorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	var body gatewayapi.UpdateWorkspaceLifecycleRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(
		r.calls,
		lifecycleCall{
			Authorization:   req.Header.Get("Authorization"),
			Body:            body,
			TenantNamespace: req.Header.Get("X-AgentZ-Tenant-Namespace"),
			WorkspaceID:     strings.TrimSuffix(strings.TrimPrefix(req.URL.Path, "/api/workspace/"), "/lifecycle"),
		},
	)
	status := http.StatusNoContent
	if len(r.statuses) > 0 {
		status = r.statuses[0]
		r.statuses = r.statuses[1:]
	}
	w.WriteHeader(status)
}

func (r *lifecycleRecorder) Calls() []lifecycleCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]lifecycleCall{}, r.calls...)
}

func newTestReconciler(t *testing.T, recorder *lifecycleRecorder) *Reconciler {
	t.Helper()
	server := httptest.NewServer(recorder)
	t.Cleanup(server.Close)
	gatewayClient, err := gatewayapi.NewClientWithResponses(server.URL, gatewayapi.WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("create gateway client: %v", err)
	}
	tokenPath := filepath.Join(t.TempDir(), "gateway-token")
	if err := os.WriteFile(tokenPath, []byte(managerToken), 0o600); err != nil {
		t.Fatalf("write gateway token: %v", err)
	}
	return &Reconciler{
		Client:                         testClient,
		Direct:                         testClient,
		CertClient:                     cmfake.NewSimpleClientset(),
		GatewayClient:                  gatewayClient,
		Scheme:                         testScheme,
		TokenPath:                      tokenPath,
		SinjectorCASecretName:          "sinjector",
		ClusterIssuerName:              "selfsigned",
		GatewayServiceAccountName:      "gateway",
		GatewayServiceAccountNamespace: "agentz-system",
		NixStorePVCName:                "nix-store",
		NixStorePVCSize:                resource.MustParse("1Gi"),
		NixStorePVCAccessModes: []corev1.PersistentVolumeAccessMode{
			corev1.ReadWriteOnce,
		},
		NixCacheTarget: networkpolicy.Target{
			Host: "cache.nixos.org",
			Port: 443,
		},
		SkillsS3Target: networkpolicy.Target{
			Host: "rustfs.rustfs.svc.cluster.local",
			Port: 9000,
		},
	}
}

func createTenant(t *testing.T, organizationID string) *agentzv1alpha1.Tenant {
	t.Helper()
	tenant := &agentzv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{Name: agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeOrganisation,
			organizationID,
		)},
		Spec: agentzv1alpha1.TenantSpec{OrganizationID: organizationID},
	}
	if err := testClient.Create(context.Background(), tenant); err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	return tenant
}

func createReadyTenant(t *testing.T, organizationID string) {
	t.Helper()
	tenant := createTenant(t, organizationID)
	markTenantReady(t, tenant.Name)
}

func markTenantReady(t *testing.T, name string) {
	t.Helper()
	var tenant agentzv1alpha1.Tenant
	if err := testClient.Get(context.Background(), client.ObjectKey{Name: name}, &tenant); err != nil {
		t.Fatalf("get tenant: %v", err)
	}
	tenant.Status.Namespace = tenant.Name
	tenant.Status.ObservedGeneration = tenant.Generation
	tenant.Status.SetCondition(metav1.Condition{
		Type:               agentzv1alpha1.TenantConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             agentzv1alpha1.TenantReasonNamespaceReady,
		Message:            "tenant namespace is ready",
		ObservedGeneration: tenant.Generation,
	})
	if err := testClient.Status().Update(context.Background(), &tenant); err != nil {
		t.Fatalf("mark tenant ready: %v", err)
	}
}

func createWorkspace(t *testing.T, organizationID, workspaceID string, attempt int64) *agentzv1alpha1.Workspace {
	t.Helper()
	workspace := &agentzv1alpha1.Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: agentzv1alpha1.ScopeNamespace(
			agentzv1alpha1.ResourceScopeWorkspace,
			workspaceID,
		)},
		Spec: agentzv1alpha1.WorkspaceSpec{
			OrganizationID:      organizationID,
			ProvisioningAttempt: attempt,
			WorkspaceID:         workspaceID,
		},
	}
	if err := testClient.Create(context.Background(), workspace); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	return workspace
}

func getWorkspace(t *testing.T, name string) *agentzv1alpha1.Workspace {
	t.Helper()
	var workspace agentzv1alpha1.Workspace
	if err := testClient.Get(context.Background(), client.ObjectKey{Name: name}, &workspace); err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	return &workspace
}

func reconcile(t *testing.T, reconciler *Reconciler, name string) {
	t.Helper()
	_, err := reconciler.Reconcile(
		context.Background(),
		ctrl.Request{NamespacedName: client.ObjectKey{Name: name}},
	)
	if err != nil {
		t.Fatalf("reconcile workspace: %v", err)
	}
}

func reconcileUntilReady(t *testing.T, reconciler *Reconciler, name string) {
	t.Helper()
	reconcile(t, reconciler, name)
	markIsolationPolicyValid(t, name)
	reconcile(t, reconciler, name)
	markCertificateReady(t, reconciler, name)
	reconcile(t, reconciler, name)
}

func markCertificateReady(t *testing.T, reconciler *Reconciler, namespace string) {
	t.Helper()
	certs := reconciler.CertClient.CertmanagerV1().Certificates(namespace)
	cert, err := certs.Get(context.Background(), "sinjector", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get sinjector certificate: %v", err)
	}
	cert.Status.Conditions = []cmapi.CertificateCondition{{
		Type:   cmapi.CertificateConditionReady,
		Status: cmmeta.ConditionTrue,
	}}
	_, err = certs.UpdateStatus(
		context.Background(),
		cert,
		metav1.UpdateOptions{},
	)
	if err != nil {
		t.Fatalf("mark sinjector certificate ready: %v", err)
	}
}

func markIsolationPolicyValid(t *testing.T, namespace string) {
	t.Helper()
	names := []string{
		agentzv1alpha1.WorkspaceIsolationPolicyName,
		agentzv1alpha1.WorkspacePackagePolicyName,
	}
	for _, name := range names {
		var policy ciliumv2.CiliumNetworkPolicy
		key := client.ObjectKey{Name: name, Namespace: namespace}
		if err := testClient.Get(context.Background(), key, &policy); err != nil {
			t.Fatalf("get %s policy: %v", name, err)
		}
		policy.Status.Conditions = []ciliumv2.NetworkPolicyCondition{{
			Type:   ciliumv2.PolicyConditionValid,
			Status: corev1.ConditionTrue,
		}}
		if err := testClient.Status().Update(context.Background(), &policy); err != nil {
			t.Fatalf("mark %s policy valid: %v", name, err)
		}
	}
}

func assertLifecycleCall(t *testing.T, call lifecycleCall, workspaceID, tenantNamespace string, attempt int64, state gatewayapi.UpdateWorkspaceLifecycleRequestState) {
	t.Helper()
	if call.WorkspaceID != workspaceID {
		t.Errorf("callback workspace ID = %q, want %q", call.WorkspaceID, workspaceID)
	}
	if call.TenantNamespace != tenantNamespace {
		t.Errorf("callback tenant namespace = %q, want %q", call.TenantNamespace, tenantNamespace)
	}
	if call.Authorization != "Bearer "+managerToken {
		t.Errorf("callback authorization = %q, want manager bearer token", call.Authorization)
	}
	if call.Body.ProvisioningAttempt != attempt {
		t.Errorf("callback attempt = %d, want %d", call.Body.ProvisioningAttempt, attempt)
	}
	if call.Body.State != state {
		t.Errorf("callback state = %q, want %q", call.Body.State, state)
	}
}
