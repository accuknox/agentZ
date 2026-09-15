package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tmaxmax/go-sse"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

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

// TestOpenCodeSchemaReferences catches incomplete OpenAPI conversion before startup.
func TestOpenCodeSchemaReferences(t *testing.T) {
	if _, err := gatewayapi.GetSwagger(); err != nil {
		t.Fatal(err)
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
