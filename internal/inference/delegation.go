package inference

import (
	"encoding/json"
	"errors"
	"slices"

	kjson "sigs.k8s.io/json"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type inferenceRequest struct {
	Model              string               `json:"model"`
	Instructions       string               `json:"instructions"`
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

// ValidateDelegatedProviderRequest checks constraints of the selected provider
// before forwarding a request to an upstream whose errors must remain private.
func ValidateDelegatedProviderRequest(kind agentzv1alpha1.InferenceProviderKind, body []byte, responses bool) error {
	if kind != agentzv1alpha1.InferenceProviderKindOpenAICodex {
		return nil
	}
	if !responses {
		return errors.New("this Codex model uses the Responses API; send requests to /responses with store:false and stream:true")
	}
	var input inferenceRequest
	strictErrors, err := kjson.UnmarshalStrict(body, &input, kjson.DisallowDuplicateFields)
	if err != nil || len(strictErrors) != 0 {
		return errors.New("provide a valid inference request with no duplicate fields")
	}
	if !input.Stream {
		return errors.New("this Codex model requires stream:true")
	}
	if input.Instructions == "" {
		return errors.New("this Codex model requires an instructions string")
	}
	return nil
}

type inferenceTool struct {
	Type string `json:"type"`
}

type inferenceInputItem struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
	Output  json.RawMessage `json:"output"`
	Audio   json.RawMessage `json:"audio"`
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
func ValidateDelegatedRequest(body []byte, responses bool) (string, error) {
	var input inferenceRequest
	strictErrors, err := kjson.UnmarshalStrict(body, &input, kjson.DisallowDuplicateFields)
	if err != nil || len(strictErrors) != 0 || input.Model == "" {
		return "", errors.New("provide a valid inference request with a model and no duplicate fields")
	}
	storedResponse := responses && (input.Store == nil || input.Background || input.PreviousResponseID != "")
	conversation := len(input.Conversation) != 0 && string(input.Conversation) != "null"
	if input.Store != nil && *input.Store || storedResponse || responses && conversation {
		return "", errors.New("use store:false and explicit conversation input; stored and background responses are unavailable")
	}
	// A model grant never authorizes the owner's stored data or hosted tools.
	storedPrompt := len(input.Prompt) != 0 && string(input.Prompt) != "null"
	hostedTools := slices.ContainsFunc(input.Tools, func(tool inferenceTool) bool {
		return tool.Type != "function"
	})
	hostedSearch := !responses && len(input.WebSearchOptions) != 0 && string(input.WebSearchOptions) != "null"
	if storedPrompt || hostedTools || hostedSearch {
		return "", errors.New("use inline prompts and client-side function tools; provider account resources are unavailable")
	}
	items := input.Messages
	if responses {
		items = nil
		// Responses input has a documented string/array union.
		if len(input.Input) != 0 && input.Input[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(input.Input, &items, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return "", errors.New("invalid response input")
			}
		}
	}
	for _, item := range items {
		if !responses && len(item.Audio) != 0 && string(item.Audio) != "null" {
			return "", errors.New("stored audio is unavailable; provide inline audio input")
		}
		// ItemReference permits omitting its type; explicit messages with IDs
		// carry type:"message" in the Responses input contract.
		implicitReference := responses && item.Type == "" && item.ID != ""
		if item.Type == "item_reference" || implicitReference {
			return "", errors.New("stored input items are unavailable; provide explicit input")
		}
		var content []inferenceContentPart
		if len(item.Content) != 0 && item.Content[0] == '[' {
			strictErrors, err = kjson.UnmarshalStrict(item.Content, &content, kjson.DisallowDuplicateFields)
			if err != nil || len(strictErrors) != 0 {
				return "", errors.New("invalid message content")
			}
		}
		if responses {
			switch item.Type {
			case "function_call_output":
				// Function output is text or an array of text, images, and files.
				if len(item.Output) != 0 && item.Output[0] == '[' {
					var output []inferenceContentPart
					strictErrors, err = kjson.UnmarshalStrict(item.Output, &output, kjson.DisallowDuplicateFields)
					if err != nil || len(strictErrors) != 0 {
						return "", errors.New("invalid function output")
					}
					content = append(content, output...)
				}
			case "computer_call_output":
				var screenshot inferenceContentPart
				strictErrors, err = kjson.UnmarshalStrict(item.Output, &screenshot, kjson.DisallowDuplicateFields)
				if err != nil || len(strictErrors) != 0 {
					return "", errors.New("invalid computer output")
				}
				content = append(content, screenshot)
			}
		}
		for _, part := range content {
			if part.FileID != "" || part.File != nil && part.File.FileID != "" {
				return "", errors.New("stored provider files are unavailable; provide inline content or a URL")
			}
		}
	}
	return input.Model, nil
}
