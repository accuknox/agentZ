package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
)

type ptyWebSocketCase struct {
	name, origin, protocol string
	status                 int
}

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
	for _, prefix := range []string{"/pty", "/api/pty"} {
		for _, origin := range []string{"https://app.example.com", "", "null", "https://app.example.com.attacker.example"} {
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
