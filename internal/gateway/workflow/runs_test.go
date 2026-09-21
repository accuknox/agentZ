package workflow

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func TestNativeWorkflowRequiresLiveAdmission(t *testing.T) {
	t.Parallel()
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	agt := &agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
		Spec:       agentzv1alpha1.AgentSpec{Execution: agentzv1alpha1.AgentExecutionNative},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(agt).Build()
	run := &agentzv1alpha1.WorkflowRun{ObjectMeta: metav1.ObjectMeta{Name: "run", Namespace: "workspace"}, Spec: agentzv1alpha1.WorkflowRunSpec{AgentName: "agent"}}
	if _, err := createRun(t.Context(), c, run, "old-connection"); err == nil {
		t.Fatal("offline native workflow was queued")
	}
	agt.Status.Connected = true
	if err := c.Update(t.Context(), agt); err != nil {
		t.Fatal(err)
	}
	if _, err := createRun(t.Context(), c, run, ""); err == nil {
		t.Fatal("stale connected status admitted workflow without live connection")
	}
	var runs agentzv1alpha1.WorkflowRunList
	if err := c.List(t.Context(), &runs); err != nil || len(runs.Items) != 0 {
		t.Fatalf("rejected requests created durable runs: %v, %#v", err, runs.Items)
	}
	if _, err := createRun(t.Context(), c, run, "live-connection"); err != nil {
		t.Fatal(err)
	}
	if run.Annotations[agentzv1alpha1.AgentComputeConnectionAnnotation] != "live-connection" {
		t.Fatal("native workflow lost its connection fence")
	}
}
