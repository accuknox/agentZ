package workflowrun

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentz "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type canceledRunCase struct {
	name      string
	phase     agentz.WorkflowRunPhase
	execution string
}

// TestBoundRunCancellation retains a terminal receipt before removing the execution session.
func TestBoundRunCancellation(t *testing.T) {
	cases := []canceledRunCase{
		{name: "before execution", phase: agentz.WorkflowRunPhasePending},
		{name: "during execution", phase: agentz.WorkflowRunPhaseRunning, execution: "ses_execution"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentz.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			now := metav1.Now()
			run := &agentz.WorkflowRun{
				ObjectMeta: metav1.ObjectMeta{
					Name:              "run",
					Namespace:         "workspace",
					UID:               types.UID("run-uid"),
					Finalizers:        []string{workflowRunFinalizer},
					DeletionTimestamp: &now,
				},
				Spec: agentz.WorkflowRunSpec{
					AgentName:    "agent",
					WorkflowName: "release",
					Delivery:     &agentz.WorkflowDelivery{SessionID: "ses_root", OwnerID: "owner"},
				},
				Status: agentz.WorkflowRunStatus{Phase: test.phase, SessionID: test.execution},
			}
			k8s := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(run).WithObjects(run).Build()
			reported := false
			deleted := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/report/reconcile") {
					var current agentz.WorkflowRun
					if err := k8s.Get(r.Context(), client.ObjectKeyFromObject(run), &current); err != nil {
						t.Error(err)
					}
					if current.Status.Phase != agentz.WorkflowRunPhaseFailed {
						t.Errorf("report observed nonterminal phase %q", current.Status.Phase)
					}
					reported = true
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if strings.Contains(r.URL.Path, "ses_root") {
					t.Error("controller attempted to modify destination root")
				}
				if test.execution == "" || !strings.Contains(r.URL.Path, test.execution) {
					t.Errorf("unexpected native request %s", r.URL.Path)
				}
				if r.Method == http.MethodDelete {
					if !reported {
						t.Error("execution removed before completion receipt")
					}
					deleted = true
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte("true"))
			}))
			defer server.Close()
			gateway, err := gatewayapi.NewClientWithResponses(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			tokenPath := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(tokenPath, []byte("test-service-account"), 0600); err != nil {
				t.Fatal(err)
			}
			reconciler := Reconciler{Client: k8s, GatewayClient: gateway, TokenPath: tokenPath}
			_, err = reconciler.Reconcile(t.Context(), ctrl.Request{
				NamespacedName: types.NamespacedName{Namespace: run.Namespace, Name: run.Name},
			})
			if err != nil {
				t.Fatal(err)
			}
			if !reported {
				t.Fatal("completion receipt was not reconciled")
			}
			if deleted != (test.execution != "") {
				t.Fatal("execution cleanup did not match owned session")
			}
			var current agentz.WorkflowRun
			err = k8s.Get(t.Context(), client.ObjectKeyFromObject(run), &current)
			if !apierrors.IsNotFound(err) {
				t.Fatalf("run finalizer was not released: %v", err)
			}
		})
	}
}
