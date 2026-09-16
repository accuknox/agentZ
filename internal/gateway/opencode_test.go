package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tmaxmax/go-sse"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/cache"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

type ptyWebSocketCase struct {
	name, origin, protocol string
	status                 int
}

// TestPTYWebSocketAuthentication keeps browser bearers out of upstream protocols.
func TestPTYWebSocketAuthentication(t *testing.T) {
	service := &Service{cfg: Config{AllowedWebOrigins: []string{"https://app.example.com"}}}
	for _, test := range []ptyWebSocketCase{
		{
			"allowed origin",
			"https://app.example.com",
			"agentz.pty, agentz.bearer.test-token",
			http.StatusNoContent,
		},
		{
			"origin suffix",
			"https://app.example.com.attacker.example",
			"agentz.pty, agentz.bearer.test-token",
			http.StatusForbidden,
		},
		{"missing origin", "", "agentz.pty, agentz.bearer.test-token", http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/opencode/test/pty/pty_test/connect", nil)
			request.Header.Set("Upgrade", "websocket")
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-WebSocket-Protocol", test.protocol)
			response := httptest.NewRecorder()
			service.ptyWebsocketAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Sec-WebSocket-Protocol") != "agentz.pty" {
					t.Error("bearer was retained in the upstream subprotocol")
				}
				if r.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("bearer was not forwarded to authentication")
				}
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("got %d, want %d", response.Code, test.status)
			}
		})
	}
}

// TestPTYProxyOrigins checks validation before forwarding to an internal host.
func TestPTYProxyOrigins(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			t.Error("browser origin reached OpenCode")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("caller credentials reached OpenCode")
		}
		if r.Header.Get("X-Opencode-Ticket") != "1" {
			t.Error("ticket header was lost")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	err := index.Add(&agentzv1alpha1.Agent{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "workspace"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{
		cfg: Config{AllowedWebOrigins: []string{"https://app.example.com"}},
		resolver: &resolver{
			agents: listersv1alpha1.NewAgentLister(index), targetOverride: upstream.URL,
		},
	}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), authContextKey{}, requestAuth{
				actorType: requestActorSystem, tenantNamespace: "workspace",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	router.With(s.ptyWebsocketAuth).HandleFunc("/api/opencode/{agentName}/*", s.handleOpenCodeProxy)
	origins := []string{
		"https://app.example.com",
		"",
		"null",
		"https://app.example.com.attacker.example",
	}
	for _, prefix := range []string{"/pty", "/api/pty"} {
		for _, origin := range origins {
			t.Run(prefix+"/"+origin, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost,
					"/api/opencode/test"+prefix+"/pty_test/connect-token", nil)
				req.Header.Set("Origin", origin)
				req.Header.Set("Authorization", "Bearer secret")
				req.Header.Set("Cookie", "secret=value")
				req.Header.Set("X-Opencode-Ticket", "1")
				resp := httptest.NewRecorder()
				router.ServeHTTP(resp, req)
				want := http.StatusForbidden
				if origin == "" || origin == "https://app.example.com" {
					want = http.StatusNoContent
				}
				if resp.Code != want {
					t.Fatalf("status %d, want %d: %s", resp.Code, want, resp.Body.String())
				}
			})
		}
	}
}

type openCodeStreamCase struct {
	name     string
	coding   bool
	global   bool
	upstream string
}

// TestOpenCodeEventTransport exercises native envelopes and large multiline frames.
func TestOpenCodeEventTransport(t *testing.T) {
	for _, test := range []openCodeStreamCase{
		{name: "coding global", coding: true, global: true, upstream: "/event"},
		{name: "coding scoped", coding: true, upstream: "/event"},
		{name: "general global", global: true, upstream: "/global/event"},
	} {
		t.Run(test.name, func(t *testing.T) {
			delta := gatewayapi.OpencodeEventMessagePartDelta{
				Id:   "evt_test",
				Type: gatewayapi.OpencodeEventMessagePartDeltaTypeMessagePartDelta,
			}
			delta.Properties.SessionID = "ses_test"
			delta.Properties.MessageID = "msg_test"
			delta.Properties.PartID = "prt_test"
			delta.Properties.Field = "text"
			delta.Properties.Delta = strings.Repeat("message\n", 12000)
			raw, err := json.MarshalIndent(delta, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			if test.global && !test.coding {
				envelope := gatewayapi.OpencodeGlobalEvent{Directory: "/upstream/checkout"}
				if err := envelope.Payload.UnmarshalJSON(raw); err != nil {
					t.Fatal(err)
				}
				raw, err = json.MarshalIndent(envelope, "", "  ")
				if err != nil {
					t.Fatal(err)
				}
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != test.upstream || r.URL.Query().Get("directory") != "/requested/checkout" {
					t.Errorf("unexpected upstream request %s", r.URL)
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("caller credentials reached the engine")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				var message sse.Message
				message.AppendData(string(raw))
				if _, err := message.WriteTo(w); err != nil {
					t.Error(err)
				}
			}))
			defer upstream.Close()
			target, err := url.Parse(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			auth := requestAuth{}
			if test.coding {
				auth.workspaceType = agentzv1alpha1.WorkspaceTypeCoding
			}
			req := httptest.NewRequest(http.MethodGet, "/event?directory=/requested/checkout", nil)
			req.Header.Set("Authorization", "Basic secret")
			req.Header.Set("Cookie", "session=secret")
			req = req.WithContext(context.WithValue(req.Context(), authContextKey{}, auth))
			route := &opencodeRouteMatch{ID: "event.subscribe"}
			if test.global {
				route.ID = "global.event"
			}
			response := httptest.NewRecorder()
			service := Service{outboundHTTP: upstream.Client()}
			service.streamOpenCodeEvents(response, req, route, target, resourceAccess{}, "agent")
			count := 0
			for event, err := range sse.Read(response.Body, &sse.ReadConfig{MaxEventSize: 1 << 20}) {
				if err != nil {
					t.Fatal(err)
				}
				count++
				data := []byte(event.Data)
				if test.global {
					var envelope gatewayapi.OpencodeGlobalEvent
					if err := json.Unmarshal(data, &envelope); err != nil {
						t.Fatal(err)
					}
					want := "/upstream/checkout"
					if test.coding {
						want = "/requested/checkout"
					}
					if envelope.Directory != want {
						t.Fatalf("directory %q, want %q", envelope.Directory, want)
					}
					data, err = envelope.Payload.MarshalJSON()
					if err != nil {
						t.Fatal(err)
					}
				}
				var received gatewayapi.OpencodeEventMessagePartDelta
				if err := json.Unmarshal(data, &received); err != nil {
					t.Fatal(err)
				}
				if received != delta {
					t.Fatal("event payload changed in transit")
				}
			}
			if count != 1 {
				t.Fatalf("received %d events, want 1", count)
			}
		})
	}
}

// TestAPIKeyPromptIdentity prevents key IDs from replacing their owner's identity.
func TestAPIKeyPromptIdentity(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost, "/session/ses_test/message",
		strings.NewReader(`{"parts":[{"type":"text","text":"hello"}]}`),
	)
	auth := requestAuth{
		actorType: requestActorAPIKey, actorID: "key_test", actorName: "Terminal key",
		userID: "user_test", userName: "Terminal user",
	}
	route := &opencodeRouteMatch{ID: "session.prompt"}
	if err := attributeOpenCodePrompt(req, route, auth); err != nil {
		t.Fatal(err)
	}
	var body gatewayapi.SessionPromptJSONBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	part, err := body.Parts[0].AsOpencodeTextPartInput()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal((*part.Metadata)[opencodeActorMetadataKey])
	if err != nil {
		t.Fatal(err)
	}
	var actor opencodeMessageActor
	if err := json.Unmarshal(raw, &actor); err != nil {
		t.Fatal(err)
	}
	if actor.ID != auth.userID || actor.Name != auth.userName || actor.Type != requestActorUser {
		t.Fatalf("prompt actor = %+v", actor)
	}
}

type codingModelCase struct {
	name                       string
	small, override            bool
	organization, unselected   bool
	missing, noParent, failure bool
}

// TestCodingSuggestionModels exercises model precedence across the OpenCode
// boundary, including scoped sandbox access and session cleanup on failure.
func TestCodingSuggestionModels(t *testing.T) {
	for _, test := range []codingModelCase{
		{name: "small", small: true},
		{name: "thread"},
		{name: "default", noParent: true},
		{name: "override", small: true, override: true, missing: true},
		{name: "organization", small: true, organization: true},
		{name: "unselected", small: true, organization: true, unselected: true},
		{name: "missing sandbox", missing: true},
		{name: "model failure", small: true, failure: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			for _, purpose := range []gatewayapi.CodingTextRequestPurpose{
				gatewayapi.CodingTextCommit, gatewayapi.CodingTextPR, gatewayapi.CodingTextBranch,
			} {
				t.Run(string(purpose), func(t *testing.T) {
					scheme := runtime.NewScheme()
					if err := corev1.AddToScheme(scheme); err != nil {
						t.Fatal(err)
					}
					if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
						t.Fatal(err)
					}
					org := agentzv1alpha1.ScopeNamespace(
						agentzv1alpha1.ResourceScopeOrganisation, "org",
					)
					ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
						Name: "workspace", Labels: map[string]string{
							agentzv1alpha1.WorkspaceNameLabel:        "workspace",
							agentzv1alpha1.TenantOrganizationIDLabel: org,
						},
					}}
					workspace := &agentzv1alpha1.Workspace{
						ObjectMeta: metav1.ObjectMeta{Name: ns.Name},
					}
					workspace.Spec.OrganizationID = "org"
					workspace.Spec.SelectedOrganizationResources.Sandboxes = []string{"sandbox"}
					if test.unselected {
						workspace.Spec.SelectedOrganizationResources.Sandboxes = nil
					}
					agent := &agentzv1alpha1.Agent{
						ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: ns.Name},
					}
					agent.Spec.SandboxRef = agentzv1alpha1.ResourceReference{
						Name: "sandbox", Scope: agentzv1alpha1.ResourceScopeWorkspace,
					}
					sandbox := &agentzv1alpha1.Sandbox{
						ObjectMeta: metav1.ObjectMeta{Name: "sandbox", Namespace: ns.Name},
					}
					if test.organization {
						agent.Spec.SandboxRef.Scope = agentzv1alpha1.ResourceScopeOrganisation
						sandbox.Namespace = org
					}
					if test.small {
						sandbox.Spec.Inference.SmallModel = &agentzv1alpha1.InferenceModelRef{
							Provider: "small-provider", Model: "family/small",
							Scope: agentzv1alpha1.ResourceScopeWorkspace,
						}
					}
					k8s := fake.NewClientBuilder().WithScheme(scheme).WithObjects(ns, workspace, sandbox).Build()
					if test.missing {
						if err := k8s.Delete(t.Context(), sandbox); err != nil {
							t.Fatal(err)
						}
					}
					index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
					if err := index.Add(agent); err != nil {
						t.Fatal(err)
					}
					parent := &gatewayapi.OpencodeModelRef{
						ProviderID: "thread-provider", Id: "thread", Variant: new("high"),
					}
					if test.noParent {
						parent = nil
					}
					want := parent
					if test.small {
						want = &gatewayapi.OpencodeModelRef{ProviderID: "small-provider", Id: "family/small"}
					}
					calls := make(chan string, 10)
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls <- r.URL.Path
						w.Header().Set("Content-Type", "application/json")
						switch r.URL.Path {
						case "/git":
							_, _ = w.Write([]byte(`{"tree":"reviewed","branch":"feat/test","files":[{"path":"file.go","index":"M","worktree":" "}],"patches":[{"patch":"+change"}]}`))
						case "/session/parent":
							if test.small || test.override {
								t.Error("loaded parent despite selected model")
							}
							_ = json.NewEncoder(w).Encode(gatewayapi.OpencodeSession{Id: "parent", Model: parent})
						case "/session":
							var body gatewayapi.SessionCreateJSONRequestBody
							if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
								t.Error(err)
								return
							}
							if !test.override && !reflect.DeepEqual(body.Model, want) {
								t.Errorf("session model = %+v, want %+v", body.Model, want)
							}
							if test.override && body.Model != nil {
								t.Error("override inherited a session model")
							}
							if body.ParentID == nil || *body.ParentID != "parent" {
								t.Error("missing parent")
							}
							if body.Permission == nil || len(*body.Permission) != 1 || (*body.Permission)[0].Action != gatewayapi.OpencodePermissionActionDeny {
								t.Error("tools were not denied")
							}
							_, _ = w.Write([]byte(`{"id":"child"}`))
						case "/session/child/message":
							var body gatewayapi.SessionPromptJSONRequestBody
							if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
								t.Error(err)
								return
							}
							if test.override {
								if body.Model == nil || body.Model.ProviderID != "override" || body.Model.ModelID != "family/override" {
									t.Errorf("prompt model = %+v", body.Model)
								}
							}
							if !test.override && body.Model != nil {
								t.Error("prompt replaced the selected session model")
							}
							if test.failure {
								http.Error(w, "model unavailable", http.StatusBadGateway)
								return
							}
							text := "feat/test"
							if purpose == gatewayapi.CodingTextPR {
								text = `{"title":"Fix behavior","body":"Explain the change"}`
							}
							raw, _ := json.Marshal(text)
							_, _ = fmt.Fprintf(w, `{"info":{},"parts":[{"type":"text","text":%s}]}`, raw)
						case "/session/child/abort", "/session/child":
							_, _ = w.Write([]byte(`true`))
						default:
							t.Errorf("unexpected request: %s", r.URL.Path)
							http.NotFound(w, r)
						}
					}))
					defer server.Close()
					svc := &Service{
						k8sClient: k8s, outboundHTTP: server.Client(),
						cfg:      Config{FilesystemTargetOverride: strings.TrimPrefix(server.URL, "http://")},
						resolver: &resolver{agents: listersv1alpha1.NewAgentLister(index), targetOverride: server.URL},
					}
					input := gatewayapi.CodingTextRequest{Purpose: purpose, Text: new("Change behavior"), ExpectedTree: new("reviewed")}
					if test.override {
						err := json.Unmarshal([]byte(`{"model":{"providerID":"override","modelID":"family/override"}}`), &input)
						if err != nil {
							t.Fatal(err)
						}
					}
					_, err := svc.codingSuggestion(t.Context(), resourceAccess{namespace: ns.Name},
						gatewaydb.CodingWorktree{AgentName: agent.Name}, gatewaydb.CodingProject{}, "parent", input)
					wantErr := test.failure || test.unselected || (test.missing && !test.override)
					if (err != nil) != wantErr {
						t.Fatalf("generation error = %v, want error %t", err, wantErr)
					}
					var paths []string
					for len(calls) > 0 {
						paths = append(paths, <-calls)
					}
					if test.unselected || (test.missing && !test.override) {
						for _, path := range paths {
							if path != "/git" {
								t.Errorf("request after sandbox failure: %s", path)
							}
						}
						return
					}
					if len(paths) < 4 || paths[len(paths)-2] != "/session/child/abort" || paths[len(paths)-1] != "/session/child" {
						t.Fatalf("missing cleanup: %v", paths)
					}
				})
			}
		})
	}
}
