package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type ptyWebSocketCase struct {
	name, origin, protocol string
	status                 int
}

// TestPTYWebSocketAuthentication keeps browser bearers out of upstream protocols.
func TestPTYWebSocketAuthentication(t *testing.T) {
	service := &Service{cfg: Config{AllowedWebOrigins: []string{"https://app.example.com"}}}
	cases := []ptyWebSocketCase{
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
		{
			"missing origin",
			"",
			"agentz.pty, agentz.bearer.test-token",
			http.StatusForbidden,
		},
	}
	for _, test := range cases {
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

// TestAPIKeyPromptIdentity prevents key IDs from replacing their owner's identity.
func TestAPIKeyPromptIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/session/ses_test/message", strings.NewReader(`{"parts":[{"type":"text","text":"hello"}]}`))
	auth := requestAuth{
		actorType: requestActorAPIKey,
		actorID:   "key_test",
		actorName: "Terminal key",
		userID:    "user_test",
		userName:  "Terminal user",
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
