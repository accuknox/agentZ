package workflowrun

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestPendingNativeWorkflowFailsOfflineInsteadOfWaiting(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
		Spec:       agentzv1alpha1.AgentSpec{Execution: agentzv1alpha1.AgentExecutionNative},
	}
	run := &agentzv1alpha1.WorkflowRun{
		ObjectMeta: metav1.ObjectMeta{
			Name: "run", Namespace: "workspace",
			Annotations: map[string]string{
				agentzv1alpha1.AgentComputeConnectionAnnotation: "old-connection",
			},
		},
		Spec:   agentzv1alpha1.WorkflowRunSpec{AgentName: "agent"},
		Status: agentzv1alpha1.WorkflowRunStatus{Phase: agentzv1alpha1.WorkflowRunPhasePending},
	}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(run).
		WithObjects(agt, run).
		Build()
	r := &Reconciler{Client: c, GatewayClient: &gatewayapi.ClientWithResponses{}}
	result, err := r.reconcilePending(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter != 0 {
		t.Fatal("offline native workflow scheduled a retry")
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(run), run); err != nil {
		t.Fatal(err)
	}
	if run.Status.Phase != agentzv1alpha1.WorkflowRunPhaseFailed || run.Status.CompletedAt == nil {
		t.Fatalf("offline native workflow did not reach terminal failure: %#v", run.Status)
	}
}
