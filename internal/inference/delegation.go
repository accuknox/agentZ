package inference

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	kjson "sigs.k8s.io/json"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// DelegatedRequest contains validated inference input for a delegated model.
type DelegatedRequest struct {
	endpoint           string
	nativeTools        bool
	Model              string               `json:"model"`
	Stream             bool                 `json:"stream"`
	Store              *bool                `json:"store"`
	Background         bool                 `json:"background"`
	PreviousResponseID string               `json:"previous_response_id"`
	Conversation       json.RawMessage      `json:"conversation"`
	Prompt             json.RawMessage      `json:"prompt"`
	WebSearchOptions   json.RawMessage      `json:"web_search_options"`
	Tools              []inferenceTool      `json:"tools"`
	Input              json.RawMessage      `json:"input"`
	Messages           []inferenceInputItem `json:"messages"`
}

// DelegatedProviderEndpoints returns the client APIs that Agentgateway can
// translate to the provider's configured format. Routes alone do not establish
// support: Responses cannot be translated to Anthropic Messages or Gemini.
func DelegatedProviderEndpoints(kind agentzv1alpha1.InferenceProviderKind) []string {
	switch kind {
	case agentzv1alpha1.InferenceProviderKindOpenAICodex:
		return []string{"/responses"}
	case agentzv1alpha1.InferenceProviderKindAnthropic, agentzv1alpha1.InferenceProviderKindAnthropicCompatible:
		return []string{"/chat/completions", "/messages", "/messages/count_tokens"}
	case agentzv1alpha1.InferenceProviderKindGemini, agentzv1alpha1.InferenceProviderKindVertexAI:
		return []string{"/chat/completions"}
	case agentzv1alpha1.InferenceProviderKindOpenAI, agentzv1alpha1.InferenceProviderKindOpenAICompatible,
		agentzv1alpha1.InferenceProviderKindAzure, agentzv1alpha1.InferenceProviderKindBedrock:
		return []string{"/chat/completions", "/responses", "/messages", "/messages/count_tokens"}
	default:
		return nil
	}
}

// ValidateProvider checks the selected provider before forwarding a validated
// request to an upstream whose errors must remain private.
func (input *DelegatedRequest) ValidateProvider(kind agentzv1alpha1.InferenceProviderKind) error {
	endpoints := DelegatedProviderEndpoints(kind)
	if len(endpoints) == 0 {
		return errors.New("this model has no supported inference endpoint")
	}
	if !slices.Contains(endpoints, input.endpoint) {
		return fmt.Errorf("this model supports %s; choose a supported endpoint", strings.Join(endpoints, ", "))
	}
	nativeResponses := kind == agentzv1alpha1.InferenceProviderKindOpenAI ||
		kind == agentzv1alpha1.InferenceProviderKindAzure || kind == agentzv1alpha1.InferenceProviderKindOpenAICodex
	if input.nativeTools && !nativeResponses {
		return errors.New("custom, namespaced and search tools require a native Responses provider")
	}
	if kind != agentzv1alpha1.InferenceProviderKindOpenAICodex {
		return nil
	}
	if !input.Stream {
		return errors.New("this Codex model requires stream:true")
	}
	return nil
}

type inferenceTool struct {
	Type      string          `json:"type"`
	Execution string          `json:"execution"`
	Tools     []inferenceTool `json:"tools"`
}

type inferenceInputItem struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Content   json.RawMessage `json:"content"`
	Output    json.RawMessage `json:"output"`
	Audio     json.RawMessage `json:"audio"`
	Execution string          `json:"execution"`
	Tools     []inferenceTool `json:"tools"`
}

type inferenceContentPart struct {
	FileID string         `json:"file_id"`
	File   *inferenceFile `json:"file"`
}

type inferenceFile struct {
	FileID string `json:"file_id"`
}

// ValidateDelegatedRequest validates the resource-bearing portions of the OpenAI
// request. Case-sensitive decoding matches the upstream contract, while strict
// duplicate detection prevents two parsers from authorizing different values.
func ValidateDelegatedRequest(body []byte, responses bool) (*DelegatedRequest, error) {
	input := DelegatedRequest{endpoint: "/chat/completions"}
	if responses {
		input.endpoint = "/responses"
	}
	strictErrors, err := kjson.UnmarshalStrict(body, &input, kjson.DisallowDuplicateFields)
	if err != nil || len(strictErrors) != 0 || input.Model == "" {
		return nil, errors.New("provide a valid inference request with a model and no duplicate fields")
	}
	storedResponse := responses && (input.Store == nil || input.Background || input.PreviousResponseID != "")
	conversation := len(input.Conversation) != 0 && string(input.Conversation) != "null"
	if input.Store != nil && *input.Store || storedResponse || responses && conversation {
		return nil, errors.New("use store:false and explicit conversation input; stored and background responses are unavailable")
	}
	// A model grant never authorizes the owner's stored data or hosted tools.
	storedPrompt := len(input.Prompt) != 0 && string(input.Prompt) != "null"
	hostedSearch := !responses && len(input.WebSearchOptions) != 0 && string(input.WebSearchOptions) != "null"
	if storedPrompt || hostedSearch {
		return nil, errors.New("use inline prompts and client-side function tools; provider account resources are unavailable")
	}
	items := input.Messages
	if responses {
		items = nil
		// Responses input has a documented string/array union.
		if len(input.Input) != 0 && input.Input[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(input.Input, &items, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return nil, errors.New("invalid response input")
			}
		}
	}
	tools := slices.Clone(input.Tools)
	for _, item := range items {
		if !responses && len(item.Audio) != 0 && string(item.Audio) != "null" {
			return nil, errors.New("stored audio is unavailable; provide inline audio input")
		}
		// ItemReference permits omitting its type; explicit messages with IDs
		// carry type:"message" in the Responses input contract.
		implicitReference := responses && item.Type == "" && item.ID != ""
		if item.Type == "item_reference" || implicitReference {
			return nil, errors.New("stored input items are unavailable; provide explicit input")
		}
		var content []inferenceContentPart
		if len(item.Content) != 0 && item.Content[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(item.Content, &content, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return nil, errors.New("invalid message content")
			}
		}
		if responses {
			switch item.Type {
			case "function_call_output", "custom_tool_call_output":
				// Function output is text or an array of text, images, and files.
				if len(item.Output) != 0 && item.Output[0] == '[' {
					var output []inferenceContentPart
					strictErrors, err = kjson.UnmarshalStrict(item.Output, &output, kjson.DisallowDuplicateFields)
					if err != nil || len(strictErrors) != 0 {
						return nil, errors.New("invalid function output")
					}
					content = append(content, output...)
				}
			case "tool_search_output":
				if item.Execution != "client" && item.Execution != "server" {
					return nil, errors.New("tool search output requires client or server execution")
				}
				input.nativeTools = true
				tools = append(tools, item.Tools...)
			case "computer_call_output":
				var screenshot inferenceContentPart
				strictErrors, err = kjson.UnmarshalStrict(item.Output, &screenshot, kjson.DisallowDuplicateFields)
				if err != nil || len(strictErrors) != 0 {
					return nil, errors.New("invalid computer output")
				}
				content = append(content, screenshot)
			}
		}
		for _, part := range content {
			if part.FileID != "" || part.File != nil && part.File.FileID != "" {
				return nil, errors.New("stored provider files are unavailable; provide inline content or a URL")
			}
		}
	}
	for len(tools) > 0 {
		tool := tools[len(tools)-1]
		tools = tools[:len(tools)-1]
		switch tool.Type {
		case "function":
			continue
		case "tool_search":
			valid := tool.Execution == "" || tool.Execution == "server" || tool.Execution == "client"
			if responses && valid {
				// Server search loads only the inline tools validated here.
				// It does not grant access to stored provider resources.
				input.nativeTools = true
				continue
			}
		case "custom", "namespace":
			if responses {
				input.nativeTools = true
				tools = append(tools, tool.Tools...)
				continue
			}
		}
		return nil, errors.New("use client-side tools; provider account resources are unavailable")
	}
	return &input, nil
}

type anthropicRequest struct {
	Model      string               `json:"model"`
	Stream     bool                 `json:"stream"`
	Container  json.RawMessage      `json:"container"`
	MCPServers json.RawMessage      `json:"mcp_servers"`
	Tools      []inferenceTool      `json:"tools"`
	Messages   []inferenceInputItem `json:"messages"`
	System     json.RawMessage      `json:"system"`
}

type anthropicContent struct {
	Type    string           `json:"type"`
	FileID  string           `json:"file_id"`
	Source  *anthropicSource `json:"source"`
	Content json.RawMessage  `json:"content"`
}

type anthropicSource struct {
	Type    string          `json:"type"`
	FileID  string          `json:"file_id"`
	Content json.RawMessage `json:"content"`
}

// ValidateDelegatedMessages admits inline Anthropic input and client-executed
// tools. A model grant never authorizes provider files, containers or hosted MCP.
func ValidateDelegatedMessages(body []byte, countTokens bool) (*DelegatedRequest, error) {
	var input anthropicRequest
	strictErrors, err := kjson.UnmarshalStrict(body, &input, kjson.DisallowDuplicateFields)
	if err != nil || len(strictErrors) != 0 || input.Model == "" {
		return nil, errors.New("provide a valid Messages request with a model and no duplicate fields")
	}
	container := len(input.Container) != 0 && string(input.Container) != "null"
	hostedMCP := len(input.MCPServers) != 0 && string(input.MCPServers) != "null"
	if container || hostedMCP {
		return nil, errors.New("provider containers and hosted MCP servers are unavailable")
	}
	for _, tool := range input.Tools {
		local := tool.Type == "" || tool.Type == "custom" || strings.HasPrefix(tool.Type, "computer_") ||
			strings.HasPrefix(tool.Type, "bash_") || strings.HasPrefix(tool.Type, "text_editor_")
		if !local {
			return nil, errors.New("use client-side tools; provider hosted tools are unavailable")
		}
	}
	contents := []json.RawMessage{input.System}
	for _, message := range input.Messages {
		contents = append(contents, message.Content)
	}
	for len(contents) > 0 {
		content := contents[len(contents)-1]
		contents = contents[:len(contents)-1]
		if len(content) == 0 || content[0] != '[' {
			continue
		}
		var parts []anthropicContent
		strictErrors, err = kjson.UnmarshalStrict(content, &parts, kjson.DisallowDuplicateFields)
		if err != nil || len(strictErrors) != 0 {
			return nil, errors.New("invalid Messages content")
		}
		for _, part := range parts {
			storedSource := part.Source != nil && (part.Source.Type == "file" || part.Source.FileID != "")
			if part.Type == "file" || part.Type == "container_upload" || part.FileID != "" || storedSource {
				return nil, errors.New("provider files are unavailable; provide inline content or a URL")
			}
			contents = append(contents, part.Content)
			if part.Source != nil {
				contents = append(contents, part.Source.Content)
			}
		}
	}
	endpoint := "/messages"
	if countTokens {
		endpoint += "/count_tokens"
	}
	return &DelegatedRequest{Model: input.Model, Stream: input.Stream, endpoint: endpoint}, nil
}
