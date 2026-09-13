package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPTYWebSocketAuthentication(t *testing.T) {
	service := &Service{cfg: Config{AllowedWebOrigins: []string{"https://app.example.com"}}}
	for _, test := range []struct {
		name, origin, protocol string
		status                 int
	}{
		{"allowed origin", "https://app.example.com", "agentz.pty, agentz.bearer.test-token", http.StatusNoContent},
		{"origin suffix", "https://app.example.com.attacker.example", "agentz.pty, agentz.bearer.test-token", http.StatusForbidden},
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
