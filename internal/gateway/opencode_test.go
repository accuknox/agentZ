package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentz "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
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
	req := httptest.NewRequest(
		http.MethodPost, "/session/ses_test/message",
		strings.NewReader(`{"parts":[{"type":"text","text":"hello"}]}`),
	)
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

// TestPrivateChatNotifications prevents another viewer from observing private activity.
func TestPrivateChatNotifications(t *testing.T) {
	var events chatSessionEvents
	owner, stopOwner := events.subscribe("workspace/owner")
	defer stopOwner()
	other, stopOther := events.subscribe("workspace/other")
	defer stopOther()
	foreign, stopForeign := events.subscribe("elsewhere/owner")
	defer stopForeign()
	<-owner
	<-other
	<-foreign
	events.publish("workspace/owner")
	select {
	case <-owner:
	default:
		t.Fatal("owner did not receive private invalidation")
	}
	select {
	case <-other:
		t.Fatal("private invalidation reached another viewer")
	default:
	}
	events.publish("workspace")
	select {
	case <-owner:
	default:
		t.Fatal("shared invalidation missed owner")
	}
	select {
	case <-other:
	default:
		t.Fatal("shared invalidation missed collaborator")
	}
	select {
	case <-foreign:
		t.Fatal("invalidation crossed workspaces")
	default:
	}
}

type unavailableConversationQueries struct {
	gatewaydb.Querier
	err error
}

func (q unavailableConversationQueries) GatewayGetChatSession(context.Context, gatewaydb.GatewayGetChatSessionParams) (gatewaydb.ChatSession, error) {
	return gatewaydb.ChatSession{}, q.err
}

// TestWorkflowReportLookupFailure keeps transient failures retryable instead of suppressing a completed result.
func TestWorkflowReportLookupFailure(t *testing.T) {
	unavailable := errors.New("database unavailable")
	service := Service{queries: unavailableConversationQueries{err: unavailable}}
	run := &agentz.WorkflowRun{
		Spec: agentz.WorkflowRunSpec{
			AgentName: "agent",
			Delivery:  &agentz.WorkflowDelivery{SessionID: "ses_root", OwnerID: "owner"},
		},
		Status: agentz.WorkflowRunStatus{Phase: agentz.WorkflowRunPhaseSucceeded},
	}
	err := service.reconcileWorkflowReport(t.Context(), resourceAccess{workspaceID: "workspace"}, run)
	if !errors.Is(err, unavailable) {
		t.Fatalf("transient lookup returned %v", err)
	}
}

// TestPromptMetadataAuthority keeps internal identities and silence buffering under gateway control.
func TestPromptMetadataAuthority(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/session/ses_test/message", strings.NewReader(`{
		"parts": [
			{"type":"text","text":"first","metadata":{"agentz.dev/input-id":"forged"}},
			{"type":"text","text":"second","metadata":{"agentz.dev/input-id":"forged"}}
		]
	}`))
	auth := requestAuth{actorType: requestActorUser, actorID: "owner", userID: "owner"}
	route := &opencodeRouteMatch{ID: "session.prompt"}
	if err := attributeOpenCodePrompt(req, route, auth); err != nil {
		t.Fatal(err)
	}
	var body gatewayapi.SessionPromptJSONBody
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	for _, part := range body.Parts {
		text, err := part.AsOpencodeTextPartInput()
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := (*text.Metadata)["agentz.dev/input-id"]; exists {
			t.Fatal("client claimed trusted queue identity")
		}
	}
	req = httptest.NewRequest(http.MethodPost, "/session/ses_test/message", strings.NewReader(`{
		"parts": [{"type":"text","text":"automatic check"}]
	}`))
	auth.actorType = requestActorSystem
	auth.actorID = "proactive"
	route.InputID = "trusted-input"
	if err := attributeOpenCodePrompt(req, route, auth); err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	text, err := body.Parts[0].AsOpencodeTextPartInput()
	if err != nil {
		t.Fatal(err)
	}
	if (*text.Metadata)["agentz.dev/input-id"] != "trusted-input" {
		t.Fatal("gateway queue identity lost")
	}
	raw, err := json.Marshal((*text.Metadata)[opencodeActorMetadataKey])
	if err != nil {
		t.Fatal(err)
	}
	var actor opencodeMessageActor
	if err := json.Unmarshal(raw, &actor); err != nil {
		t.Fatal(err)
	}
	if actor.Type != requestActorSystem || actor.ID != "proactive" {
		t.Fatalf("internal prompt attributed to human: %+v", actor)
	}
}
