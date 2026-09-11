package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listers "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"
)

func TestCodingFilesystemRequiresReviewRevision(t *testing.T) {
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	err := index.Add(&agentzv1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{
		Name: "coding-agent", Namespace: "workspace",
	}})
	if err != nil {
		t.Fatal(err)
	}
	// An older sandbox returns valid JSON with the legacy diff fields. Decoding
	// it must not turn a modified file into a successful, empty review.
	var body atomic.Pointer[string]
	legacy := `{"branch":"main","branches":["main"],"head":"abc","files":[{"path":"Makefile","index":" ","worktree":"M"}],"diff":"diff --git a/Makefile b/Makefile\n","staged_diff":""}`
	body.Store(&legacy)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(*body.Load()))
	}))
	t.Cleanup(server.Close)
	svc := &Service{
		cfg:          Config{FilesystemTargetOverride: server.URL},
		resolver:     &resolver{agents: listers.NewAgentLister(index)},
		outboundHTTP: server.Client(),
	}
	tree := gatewaydb.CodingWorktree{AgentName: "coding-agent"}
	for _, operation := range []gatewayapi.CodingGitRequestOperation{
		gatewayapi.CodingGitStatus, gatewayapi.CodingGitDiff,
	} {
		_, err := svc.codingFilesystem(t.Context(), "workspace", tree,
			gatewaydb.CodingProject{}, false, "main",
			gatewayapi.CodingGitRequest{Operation: operation})
		if err == nil || !strings.Contains(err.Error(), "Update the agent image") {
			t.Fatalf("%s accepted an incompatible sandbox: %v", operation, err)
		}
	}
	// A clean checkout from the current service is still a successful result.
	current := `{"branch":"main","branches":["main"],"head":"abc","files":[],"patches":[],"revision":"` + strings.Repeat("a", 64) + `"}`
	body.Store(&current)
	result, err := svc.codingFilesystem(t.Context(), "workspace", tree,
		gatewaydb.CodingProject{}, false, "main",
		gatewayapi.CodingGitRequest{Operation: gatewayapi.CodingGitDiff})
	if err != nil || result.Revision == "" || len(result.Files) != 0 {
		t.Fatalf("current sandbox rejected: %+v, %v", result, err)
	}
}
