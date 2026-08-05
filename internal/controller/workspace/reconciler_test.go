//go:build controller

package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
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
	utilruntime.Must(agentzv1alpha1.AddToScheme(testScheme))

	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "..", "deploy", "kustomize", "crd", "bases")},
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

	reconcile(t, reconciler, workspace.Name)

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

func TestReconcileRecordsFailedProvisioning(t *testing.T) {
	organizationID := "org-workspace-failure"
	workspaceID := "workspace-failure"
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)

	current := getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateFailed {
		t.Fatalf("state = %q, want %q", current.Status.State, agentzv1alpha1.WorkspaceStateFailed)
	}
	if !apimeta.IsStatusConditionTrue(current.Status.Conditions, agentzv1alpha1.WorkspaceConditionDegraded) {
		t.Fatal("Degraded condition is not true")
	}
	var ns corev1.Namespace
	err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &ns)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("get failed workspace namespace error = %v, want not found", err)
	}

	calls := recorder.Calls()
	if len(calls) != 1 {
		t.Fatalf("lifecycle calls = %d, want 1", len(calls))
	}
	tenantName := agentzv1alpha1.ScopeNamespace(
		agentzv1alpha1.ResourceScopeOrganisation,
		organizationID,
	)
	assertLifecycleCall(
		t,
		calls[0],
		workspaceID,
		tenantName,
		1,
		gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed,
	)
	if calls[0].Body.FailureReason == nil || *calls[0].Body.FailureReason == "" {
		t.Fatal("failed lifecycle call has no failure reason")
	}
}

func TestReconcileRetriesOnlyAfterAttemptIncreases(t *testing.T) {
	organizationID := "org-workspace-retry"
	workspaceID := "workspace-retry"
	tenant := createTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
	recorder := &lifecycleRecorder{}
	reconciler := newTestReconciler(t, recorder)

	reconcile(t, reconciler, workspace.Name)
	markTenantReady(t, tenant.Name)
	reconcile(t, reconciler, workspace.Name)

	var ns corev1.Namespace
	err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &ns)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("get workspace namespace before retry error = %v, want not found", err)
	}

	current := getWorkspace(t, workspace.Name)
	current.Spec.ProvisioningAttempt++
	if err := testClient.Update(context.Background(), current); err != nil {
		t.Fatalf("increment provisioning attempt: %v", err)
	}
	reconcile(t, reconciler, workspace.Name)

	current = getWorkspace(t, workspace.Name)
	if current.Status.State != agentzv1alpha1.WorkspaceStateReady {
		t.Fatalf("state after retry = %q, want %q", current.Status.State, agentzv1alpha1.WorkspaceStateReady)
	}
	if current.Status.ObservedAttempt != 2 {
		t.Fatalf("observed attempt after retry = %d, want 2", current.Status.ObservedAttempt)
	}
	if err := testClient.Get(context.Background(), client.ObjectKey{Name: workspace.Name}, &ns); err != nil {
		t.Fatalf("get workspace namespace after retry: %v", err)
	}

	calls := recorder.Calls()
	if len(calls) != 2 {
		t.Fatalf("lifecycle calls = %d, want 2", len(calls))
	}
	if calls[0].Body.State != gatewayapi.UpdateWorkspaceLifecycleRequestStateFailed ||
		calls[1].Body.State != gatewayapi.UpdateWorkspaceLifecycleRequestStateReady {
		t.Fatalf("lifecycle states = %q, %q", calls[0].Body.State, calls[1].Body.State)
	}
	if calls[1].Body.ProvisioningAttempt != 2 {
		t.Fatalf("ready lifecycle attempt = %d, want 2", calls[1].Body.ProvisioningAttempt)
	}
}

func TestReconcileRetriesTerminalGatewayObservation(t *testing.T) {
	organizationID := "org-workspace-gateway-retry"
	workspaceID := "workspace-gateway-retry"
	createReadyTenant(t, organizationID)
	workspace := createWorkspace(t, organizationID, workspaceID, 1)
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
	if current.Status.State != agentzv1alpha1.WorkspaceStateProvisioning {
		t.Fatalf("state after callback failure = %q, want Provisioning", current.Status.State)
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
	r.calls = append(r.calls, lifecycleCall{
		Authorization:   req.Header.Get("Authorization"),
		Body:            body,
		TenantNamespace: req.Header.Get("X-AgentZ-Tenant-Namespace"),
		WorkspaceID:     strings.TrimSuffix(strings.TrimPrefix(req.URL.Path, "/api/workspace/"), "/lifecycle"),
	})
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
		Client:        testClient,
		Direct:        testClient,
		GatewayClient: gatewayClient,
		Scheme:        testScheme,
		TokenPath:     tokenPath,
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
