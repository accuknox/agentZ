package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestAttributeOpenCodePrompt(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/opencode/demo/session/ses_1/prompt_async",
		strings.NewReader(`{
			"messageID":"msg_1",
			"parts":[
				{"type":"text","text":"hello","metadata":{"client":"kept","agentz.dev/actor":{"version":1,"type":"user","id":"spoofed","name":"Spoofed"}}},
				{"type":"text","text":"world","metadata":{"agentz.dev/actor":{"version":1,"type":"user","id":"spoofed-again","name":"Spoofed"}}}
			]
		}`),
	)
	route := &opencodeRouteMatch{Method: http.MethodPost, Path: opencodeSessionAsyncPath}
	auth := requestAuth{
		actorType: requestActorUser,
		actorID:   "user-1",
		actorName: "Ada Lovelace",
	}

	if err := attributeOpenCodePrompt(request, route, auth); err != nil {
		t.Fatalf("attribute prompt: %v", err)
	}

	var body gatewayapi.SessionPromptJSONBody
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatalf("decode attributed prompt: %v", err)
	}
	if len(body.Parts) != 2 {
		t.Fatalf("got %d parts, want 2", len(body.Parts))
	}
	first, err := body.Parts[0].AsOpencodeTextPartInput()
	if err != nil {
		t.Fatalf("decode first text part: %v", err)
	}
	if first.Metadata == nil || (*first.Metadata)["client"] != "kept" {
		t.Fatalf("first part metadata was not preserved: %#v", first.Metadata)
	}
	actorJSON, err := json.Marshal((*first.Metadata)[opencodeActorMetadataKey])
	if err != nil {
		t.Fatalf("encode actor metadata: %v", err)
	}
	var actor opencodeMessageActor
	if err := json.Unmarshal(actorJSON, &actor); err != nil {
		t.Fatalf("decode actor metadata: %v", err)
	}
	want := opencodeMessageActor{
		Version: 1,
		Type:    requestActorUser,
		ID:      "user-1",
		Name:    "Ada Lovelace",
	}
	if actor != want {
		t.Fatalf("got actor %#v, want %#v", actor, want)
	}

	second, err := body.Parts[1].AsOpencodeTextPartInput()
	if err != nil {
		t.Fatalf("decode second text part: %v", err)
	}
	if second.Metadata == nil {
		t.Fatal("second part metadata is nil")
	}
	if _, exists := (*second.Metadata)[opencodeActorMetadataKey]; exists {
		t.Fatal("caller actor metadata survived on the second part")
	}
}

func TestAttributeOpenCodeAttachmentPrompt(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/opencode/demo/session/ses_1/message",
		strings.NewReader(`{"parts":[{"type":"file","mime":"image/png","url":"data:image/png;base64,AA=="}]}`),
	)
	route := &opencodeRouteMatch{Method: http.MethodPost, Path: opencodeSessionPromptPath}
	auth := requestAuth{
		actorType: requestActorAPIKey,
		actorID:   "key-1",
		actorName: "Automation",
	}

	if err := attributeOpenCodePrompt(request, route, auth); err != nil {
		t.Fatalf("attribute prompt: %v", err)
	}

	var body gatewayapi.SessionPromptJSONBody
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatalf("decode attributed prompt: %v", err)
	}
	if len(body.Parts) != 2 {
		t.Fatalf("got %d parts, want 2", len(body.Parts))
	}
	carrier, err := body.Parts[1].AsOpencodeTextPartInput()
	if err != nil {
		t.Fatalf("decode actor carrier: %v", err)
	}
	ignored := carrier.Ignored != nil && *carrier.Ignored
	synthetic := carrier.Synthetic != nil && *carrier.Synthetic
	if !ignored || !synthetic || carrier.Text != "" {
		t.Fatalf("unexpected actor carrier: %#v", carrier)
	}
	if carrier.Metadata == nil {
		t.Fatal("actor carrier metadata is nil")
	}
	actorJSON, err := json.Marshal((*carrier.Metadata)[opencodeActorMetadataKey])
	if err != nil {
		t.Fatalf("encode actor metadata: %v", err)
	}
	var actor opencodeMessageActor
	if err := json.Unmarshal(actorJSON, &actor); err != nil {
		t.Fatalf("decode actor metadata: %v", err)
	}
	if actor.Type != requestActorAPIKey || actor.ID != "key-1" || actor.Name != "Automation" {
		t.Fatalf("unexpected actor metadata: %#v", actor)
	}
}
