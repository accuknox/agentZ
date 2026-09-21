package gateway

import (
	"net/http"
	"testing"

	"github.com/accuknox/agentz/internal/compute"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

type runtimeRootCase struct {
	name      string
	execution agentzv1alpha1.AgentExecution
	reported  string
	want      string
}

func TestResolveAgentRuntimeRoot(t *testing.T) {
	t.Parallel()
	for _, tc := range []runtimeRootCase{
		{name: "legacy", want: "/home/agentz"},
		{name: "kubernetes", execution: agentzv1alpha1.AgentExecutionKubernetes, want: "/home/agentz"},
		{name: "native", execution: agentzv1alpha1.AgentExecutionNative, reported: "/home/alice/agentz", want: "/home/alice/agentz"},
		{name: "native unreported", execution: agentzv1alpha1.AgentExecutionNative},
		{name: "native relative", execution: agentzv1alpha1.AgentExecutionNative, reported: "agentz"},
		{name: "native unsafe root", execution: agentzv1alpha1.AgentExecutionNative, reported: "/"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
			if err := index.Add(&agentzv1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"}, Spec: agentzv1alpha1.AgentSpec{Execution: tc.execution}, Status: agentzv1alpha1.AgentStatus{RuntimeRoot: tc.reported}}); err != nil {
				t.Fatal(err)
			}
			r := &resolver{agents: listersv1alpha1.NewAgentLister(index)}
			resolved, err := r.resolveAgent(t.Context(), "workspace", "agent")
			if tc.want == "" {
				if err == nil {
					t.Fatal("accepted unverified native working root")
				}
				return
			}
			if err != nil || resolved.Root != tc.want {
				t.Fatalf("resolve root: %#v, %v; want %q", resolved, err, tc.want)
			}
		})
	}
}

func TestNativeAdmissionRejectsStaleConnectedStatus(t *testing.T) {
	t.Parallel()
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	if err := index.Add(&agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "workspace"},
		Spec:       agentzv1alpha1.AgentSpec{Execution: agentzv1alpha1.AgentExecutionNative},
		Status:     agentzv1alpha1.AgentStatus{RuntimeRoot: "/home/alice/agentz", Connected: true},
	}); err != nil {
		t.Fatal(err)
	}
	s := &Service{resolver: &resolver{agents: listersv1alpha1.NewAgentLister(index)}, computeServer: compute.NewServer(compute.Callbacks{})}
	connection, apiErr := s.nativeAdmission(t.Context(), "workspace", "agent")
	if connection != "" || apiErr == nil || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("stale CR status admitted new native work: connection=%q, err=%v", connection, apiErr)
	}
}
