package workflowrun

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	"github.com/google/uuid"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestRunningWorkflowTracksExecution(t *testing.T) {
	states := []gatewayapi.ConversationExecutionState{
		gatewayapi.ConversationExecutionStateAdmitting,
		gatewayapi.ConversationExecutionStateRunning,
		gatewayapi.ConversationExecutionStateRecovering,
		gatewayapi.ConversationExecutionStateBlocked,
		gatewayapi.ConversationExecutionStateCompleted,
		gatewayapi.ConversationExecutionStateFailed,
		gatewayapi.ConversationExecutionStateCancelled,
	}
	for _, state := range states {
		t.Run(string(state), func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			executionID := uuid.New()
			run := &agentzv1alpha1.WorkflowRun{
				ObjectMeta: metav1.ObjectMeta{
					Name: "run", Namespace: "workspace", UID: "run-uid",
				},
				Spec: agentzv1alpha1.WorkflowRunSpec{
					AgentName: "agent", WorkflowName: "workflow",
				},
				Status: agentzv1alpha1.WorkflowRunStatus{
					Phase:       agentzv1alpha1.WorkflowRunPhaseRunning,
					SessionID:   "session",
					ExecutionID: executionID.String(),
					Nodes: []agentzv1alpha1.WorkflowRunNodeStatus{
						{Name: "first", Phase: agentzv1alpha1.WorkflowRunNodePhaseSucceeded},
						{Name: "second", Phase: agentzv1alpha1.WorkflowRunNodePhaseRunning},
					},
				},
			}
			kube := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(run).WithObjects(run).Build()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "/abort") {
					fmt.Fprint(w, `true`)
					return
				}
				response := gatewayapi.ChatExecutionResponse{
					Execution: &gatewayapi.ConversationExecution{
						Id:            executionID,
						State:         state,
						Attempt:       2,
						Continuations: 1,
						Reason:        "observed",
						Message:       "Execution observed",
						CreatedAt:     time.Now(),
						UpdatedAt:     time.Now(),
					},
				}
				if err := json.NewEncoder(w).Encode(response); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			token := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(token, []byte("test"), 0o600); err != nil {
				t.Fatal(err)
			}
			gateway, err := gatewayapi.NewClientWithResponses(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			r := &Reconciler{Client: kube, GatewayClient: gateway, TokenPath: token}
			result, err := r.reconcileRunning(t.Context(), run)
			if err != nil {
				t.Fatal(err)
			}
			current := &agentzv1alpha1.WorkflowRun{}
			if err := kube.Get(t.Context(), client.ObjectKeyFromObject(run), current); err != nil {
				t.Fatal(err)
			}
			if current.Status.Nodes[0].Phase != agentzv1alpha1.WorkflowRunNodePhaseSucceeded {
				t.Fatal("successful node changed")
			}
			switch state {
			case gatewayapi.ConversationExecutionStateCompleted:
				if current.Status.Phase != agentzv1alpha1.WorkflowRunPhaseUnacked {
					t.Fatalf("phase=%s", current.Status.Phase)
				}
			case gatewayapi.ConversationExecutionStateFailed, gatewayapi.ConversationExecutionStateCancelled:
				if current.Status.Phase != agentzv1alpha1.WorkflowRunPhaseFailed {
					t.Fatalf("phase=%s", current.Status.Phase)
				}
			default:
				active := current.Status.Phase == agentzv1alpha1.WorkflowRunPhaseRunning
				if !active || result.RequeueAfter == 0 {
					t.Fatal("active execution was terminated")
				}
				if current.Status.Nodes[1].Phase != agentzv1alpha1.WorkflowRunNodePhaseRunning {
					t.Fatal("running node changed during recovery")
				}
			}
		})
	}
}
