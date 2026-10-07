package extauth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/accuknox/agentz/internal/mcp"
	"github.com/accuknox/agentz/internal/oauth"
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
	for _, operation := range []string{"inference", "mcp"} {
		t.Run(operation, func(t *testing.T) {
			for _, test := range []ownerRevisionCase{
				{name: "current", uid: "original", generation: strconv.FormatInt(metadata.Generation, 10), want: codes.OK},
				{name: "stale spec", uid: "original", generation: "1", want: codes.Unavailable},
				{name: "missing revision", uid: "original", want: codes.Unavailable},
				{name: "wrong owner", uid: "original", generation: "2", namespace: "foreign", want: codes.PermissionDenied},
				{name: "replaced resource", uid: "replacement", generation: "2", want: codes.Unavailable},
			} {
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
	synctest.Test(t, func(t *testing.T) {
		oldRefresh := make(chan struct{})
		currentRead := make(chan struct{}, 1)
		transport := credentialTransport(func(r *http.Request) (*http.Response, error) {
			var payload any
			switch r.URL.Host {
			case "bao.invalid":
				path := strings.TrimPrefix(r.URL.Path, "/v1/secrets/data/")
				if path == "current" {
					select {
					case currentRead <- struct{}{}:
					default:
					}
				}
				record := mcp.OAuthSecretRecord{Record: oauth.Record{
					ClientID: path,
					Token:    &oauth2.Token{AccessToken: "expired", RefreshToken: path, Expiry: time.Unix(1, 0)},
				}}
				data, err := json.Marshal(record)
				if err != nil {
					return nil, err
				}
				payload = baoapi.Secret{Data: map[string]any{"data": map[string]any{"credentials": string(data)}}}
			case "8.8.8.8":
				if err := r.ParseForm(); err != nil {
					return nil, err
				}
				identity := r.Form.Get("refresh_token")
				if identity == "old" {
					<-oldRefresh
				}
				payload = map[string]any{"access_token": identity + "-access", "token_type": "Bearer", "expires_in": 3600}
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
		go func() { oldToken, _, _, oldErr = service.resolveOAuthAccessToken(t.Context(), old) }()
		synctest.Wait()
		go func() { currentToken, _, _, currentErr = service.resolveOAuthAccessToken(t.Context(), current) }()
		<-currentRead
		close(oldRefresh)
		synctest.Wait()
		if oldErr != nil || currentErr != nil {
			t.Fatalf("refresh errors: old=%v current=%v", oldErr, currentErr)
		}
		if oldToken != "old-access" || currentToken != "current-access" {
			t.Fatalf("credentials crossed resource revisions: old=%q current=%q", oldToken, currentToken)
		}
	})
}

type probeRevisionCase struct {
	name       string
	uid        types.UID
	generation int64
	probeTime  time.Time
	updated    bool
}

func TestMCPProbeCatalogRequiresCurrentResourceRevision(t *testing.T) {
	for _, test := range []probeRevisionCase{
		{name: "current", uid: "original", generation: 2, probeTime: time.Unix(3, 0), updated: true},
		{name: "replaced connection", uid: "replacement", generation: 2, probeTime: time.Unix(3, 0)},
		{name: "changed endpoint", uid: "original", generation: 1, probeTime: time.Unix(3, 0)},
		{name: "older result", uid: "original", generation: 2, probeTime: time.Unix(1, 0)},
	} {
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
