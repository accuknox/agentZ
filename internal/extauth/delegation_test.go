package extauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/oauth"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	baoapi "github.com/openbao/openbao/api/v2"
	"golang.org/x/oauth2"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	"google.golang.org/grpc/codes"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type ownerRevisionCase struct {
	name, uid, generation, namespace string
	want                             codes.Code
}

func TestDelegationCredentialsRequireProjectedResourceRevision(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	metadata := metav1.ObjectMeta{Name: "selected", Namespace: "owner", UID: "original", Generation: 2}
	provider := &agentzv1alpha1.InferenceProvider{
		ObjectMeta: metadata,
		Spec:       agentzv1alpha1.InferenceProviderSpec{Kind: agentzv1alpha1.InferenceProviderKindOpenAI},
	}
	connection := &agentzv1alpha1.MCPConnection{ObjectMeta: metadata}
	service := &Service{
		namespace: "owner",
		kube:      fake.NewClientBuilder().WithScheme(scheme).WithObjects(provider, connection).Build(),
	}
	operations := []string{"inference", "mcp"}
	for _, operation := range operations {
		t.Run(operation, func(t *testing.T) {
			cases := []ownerRevisionCase{
				{name: "current", uid: "original", generation: strconv.FormatInt(metadata.Generation, 10), want: codes.OK},
				{name: "stale spec", uid: "original", generation: "1", want: codes.Unavailable},
				{name: "missing revision", uid: "original", want: codes.Unavailable},
				{name: "wrong owner", uid: "original", generation: "2", namespace: "foreign", want: codes.PermissionDenied},
				{name: "replaced resource", uid: "replacement", generation: "2", want: codes.Unavailable},
			}
			for _, test := range cases {
				t.Run(test.name, func(t *testing.T) {
					owner := "owner"
					if test.namespace != "" {
						owner = test.namespace
					}
					request := &authv3.CheckRequest{Attributes: &authv3.AttributeContext{
						ContextExtensions: map[string]string{
							"agentz.operation": operation, "agentz.namespace": owner, "agentz.name": "selected",
							"agentz.uid": test.uid, "agentz.generation": test.generation, "agentz.target": "model",
						},
						Request: &authv3.AttributeContext_Request{Http: &authv3.AttributeContext_HttpRequest{
							Method: "POST", Path: "/v1/chat/completions", Body: `{"model":"model","messages":[]}`,
						}},
					}}
					ordinary, err := service.Check(t.Context(), request)
					if err != nil {
						t.Fatal(err)
					}
					if ordinary.GetStatus().GetCode() != int32(codes.PermissionDenied) || ordinary.GetOkResponse() != nil {
						t.Fatal("ordinary authorization listener admitted delegated credential access")
					}

					response, err := (&delegationServer{Service: service}).Check(t.Context(), request)
					if err != nil {
						t.Fatal(err)
					}
					if response.GetStatus().GetCode() != int32(test.want) {
						t.Fatalf("status %v, want %v", response.GetStatus(), test.want)
					}
					if test.want != codes.OK && response.GetOkResponse() != nil {
						t.Fatal("stale resource returned credential injection")
					}
				})
			}
		})
	}
}

type credentialTransport func(*http.Request) (*http.Response, error)

func (f credentialTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestOAuthRefreshKeepsConcurrentConnectionCredentialsSeparate(t *testing.T) {
	oldRefresh := make(chan struct{})
	oldStarted := make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(oldRefresh) })
	var secretsMu sync.Mutex
	secrets := make(map[string]json.RawMessage)
	transport := credentialTransport(func(r *http.Request) (*http.Response, error) {
		var payload any
		switch r.URL.Host {
		case "bao.invalid":
			path := strings.TrimPrefix(r.URL.Path, "/v1/secrets/data/")
			secretsMu.Lock()
			defer secretsMu.Unlock()
			if r.Method == http.MethodPut {
				var update map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
					return nil, err
				}
				secrets[path] = update["data"]
			}
			if secrets[path] == nil {
				record := mcp.OAuthSecretRecord{Record: oauth.Record{
					ClientID: path,
					Token:    &oauth2.Token{AccessToken: "expired", RefreshToken: path, Expiry: time.Unix(1, 0)},
				}}
				data, err := json.Marshal(record)
				if err != nil {
					return nil, err
				}
				secrets[path], err = json.Marshal(map[string]string{"credentials": string(data)})
				if err != nil {
					return nil, err
				}
			}
			payload = baoapi.Secret{Data: map[string]any{"data": secrets[path]}}
		case "8.8.8.8":
			if err := r.ParseForm(); err != nil {
				return nil, err
			}
			identity := r.Form.Get("refresh_token")
			if identity == "old" {
				close(oldStarted)
				<-oldRefresh
			}
			payload = map[string]any{"access_token": identity + "-access", "token_type": "Bearer", "expires_in": 30}
		default:
			return nil, fmt.Errorf("unexpected request: %s", r.URL)
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(data))}, nil
	})
	bao, err := baoapi.NewClient(&baoapi.Config{Address: "http://bao.invalid", HttpClient: &http.Client{Transport: transport}})
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{kv: bao.KVv2("secrets"), http: &http.Client{Transport: transport}}
	old := &agentzv1alpha1.MCPConnection{
		ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: "owner", UID: "original", Generation: 1},
		Spec: agentzv1alpha1.MCPConnectionSpec{Auth: &agentzv1alpha1.MCPConnectionAuth{
			OAuth: &agentzv1alpha1.MCPConnectionOAuthAuth{
				TokenEndpoint: "https://8.8.8.8/token",
				SecretRef:     &agentzv1alpha1.MCPConnectionSecretRef{Path: "old", Key: "credentials"},
			},
		}},
	}
	current := old.DeepCopy()
	current.Generation++
	current.Spec.Auth.OAuth.SecretRef.Path = "current"
	var oldToken, currentToken string
	var oldErr, currentErr error
	oldDone := make(chan struct{})
	go func() {
		oldToken, _, _, oldErr = service.resolveOAuthAccessToken(t.Context(), old)
		close(oldDone)
	}()
	select {
	case <-oldStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("old credential never reached the token endpoint")
	}
	currentDone := make(chan struct{})
	go func() {
		currentToken, _, _, currentErr = service.resolveOAuthAccessToken(t.Context(), current)
		close(currentDone)
	}()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	canceled := make(chan error, 1)
	go func() {
		_, _, _, err := service.resolveOAuthAccessToken(ctx, old)
		canceled <- err
	}()
	cancel()
	select {
	case <-currentDone:
	case <-time.After(5 * time.Second):
		t.Error("an unrelated credential waited for the blocked refresh")
	}
	select {
	case err := <-canceled:
		if err == nil {
			t.Error("canceled refresh waiter succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Error("a canceled waiter remained blocked by the refresh")
	}
	release.Do(func() { close(oldRefresh) })
	select {
	case <-oldDone:
	case <-time.After(5 * time.Second):
		t.Fatal("old refresh did not finish after release")
	}
	select {
	case <-currentDone:
	case <-time.After(5 * time.Second):
		t.Fatal("current refresh did not finish after release")
	}
	if oldErr != nil || currentErr != nil {
		t.Fatalf("refresh errors: old=%v current=%v", oldErr, currentErr)
	}
	if oldToken != "old-access" || currentToken != "current-access" {
		t.Fatalf("credentials crossed resource revisions: old=%q current=%q", oldToken, currentToken)
	}
}

type probeRevisionCase struct {
	name       string
	uid        types.UID
	generation int64
	probeTime  time.Time
	updated    bool
}

type probeCatalogCase struct {
	name    string
	count   int
	uriSize int
	healthy bool
}

func TestMCPProbeDiscoversBoundedPaginatedCatalog(t *testing.T) {
	cases := []probeCatalogCase{
		{name: "empty", healthy: true},
		{name: "multiple pages", count: 5, healthy: true},
		{name: "item limit", count: maxProbeCatalogItems + 1},
		{name: "byte limit", count: 2, uriSize: maxProbeCatalogBytes / 2},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "probe-test"}, &mcpsdk.ServerOptions{
				PageSize: 2,
				Capabilities: &mcpsdk.ServerCapabilities{
					Tools: &mcpsdk.ToolCapabilities{}, Prompts: &mcpsdk.PromptCapabilities{},
					Resources: &mcpsdk.ResourceCapabilities{},
				},
			})
			for i := range test.count {
				name := fmt.Sprintf("item-%04d", i)
				server.AddTool(&mcpsdk.Tool{Name: name, InputSchema: json.RawMessage(`{"type":"object"}`)}, nil)
				server.AddPrompt(&mcpsdk.Prompt{Name: name}, nil)
				server.AddResource(&mcpsdk.Resource{URI: "test:///" + name + strings.Repeat("x", test.uriSize)}, nil)
			}
			upstream := httptest.NewServer(mcpsdk.NewStreamableHTTPHandler(
				func(*http.Request) *mcpsdk.Server { return server },
				&mcpsdk.StreamableHTTPOptions{JSONResponse: true},
			))
			defer upstream.Close()
			service := &Service{probeTimeout: 10 * time.Second}
			connection := &agentzv1alpha1.MCPConnection{Spec: agentzv1alpha1.MCPConnectionSpec{
				Endpoint: agentzv1alpha1.MCPConnectionEndpoint{URL: upstream.URL},
			}}
			outcome := service.probeMCPConnectionOnce(t.Context(), connection)
			if outcome.healthy != test.healthy {
				t.Fatalf("healthy = %v, want %v: %s", outcome.healthy, test.healthy, outcome.message)
			}
			if !test.healthy {
				if !strings.Contains(outcome.message, "limit") {
					t.Fatalf("expected catalog limit rejection, got %s", outcome.message)
				}
				return
			}
			if len(outcome.tools) != test.count || len(outcome.prompts) != test.count || len(outcome.resources) != test.count {
				t.Fatalf("incomplete catalog: tools=%d prompts=%d resources=%d", len(outcome.tools), len(outcome.prompts), len(outcome.resources))
			}
			for i := range test.count {
				name := fmt.Sprintf("item-%04d", i)
				if outcome.tools[i].Name != name || outcome.prompts[i] != name || outcome.resources[i] != "test:///"+name {
					t.Fatalf("catalog identifiers changed: tool=%q prompt=%q resource=%q", outcome.tools[i].Name, outcome.prompts[i], outcome.resources[i])
				}
			}
		})
	}
}

func TestMCPProbeCatalogRequiresCurrentResourceRevision(t *testing.T) {
	cases := []probeRevisionCase{
		{name: "current", uid: "original", generation: 2, probeTime: time.Unix(3, 0), updated: true},
		{name: "replaced connection", uid: "replacement", generation: 2, probeTime: time.Unix(3, 0)},
		{name: "changed endpoint", uid: "original", generation: 1, probeTime: time.Unix(3, 0)},
		{name: "older result", uid: "original", generation: 2, probeTime: time.Unix(1, 0)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			current := &agentzv1alpha1.MCPConnection{
				ObjectMeta: metav1.ObjectMeta{Name: "selected", Namespace: "owner", UID: "original", Generation: 2},
				Status:     agentzv1alpha1.MCPConnectionStatus{Tools: []agentzv1alpha1.MCPConnectionTool{{Name: "current"}}, LastProbeTime: new(metav1.NewTime(time.Unix(2, 0)))},
			}
			service := &Service{kube: fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(current).WithObjects(current).Build()}
			probed := current.DeepCopy()
			probed.UID, probed.Generation = test.uid, test.generation
			outcome := mcpProbeOutcome{healthy: true, reason: mcp.ReasonReady, lastProbeTime: metav1.NewTime(test.probeTime), tools: []agentzv1alpha1.MCPConnectionTool{{Name: "probed"}}}
			if err := service.writeMCPProbeStatus(t.Context(), probed, outcome); err != nil {
				t.Fatal(err)
			}
			if err := service.kube.Get(t.Context(), client.ObjectKeyFromObject(current), current); err != nil {
				t.Fatal(err)
			}
			want := "current"
			if test.updated {
				want = "probed"
			}
			if len(current.Status.Tools) != 1 || current.Status.Tools[0].Name != want {
				t.Fatalf("catalog = %v, want %q", current.Status.Tools, want)
			}
		})
	}
}
