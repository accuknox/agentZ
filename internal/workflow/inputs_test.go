package workflow

import (
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestValidateDefinition(t *testing.T) {
	description := "payload"
	emptyDescription := " "
	enabled := gatewayapi.JSONValue{}
	if err := enabled.FromJSONValue0(true); err != nil {
		t.Fatalf("FromJSONValue0() error = %v", err)
	}
	defaultPayload := gatewayapi.JSONValue{}
	err := defaultPayload.FromJSONValue4(gatewayapi.JSONValue4{"enabled": &enabled})
	if err != nil {
		t.Fatalf("FromJSONValue4() error = %v", err)
	}
	inputs := gatewayapi.WorkflowInputs{
		"target": gatewayapi.WorkflowInputSchema{
			Type:     gatewayapi.String,
			Required: true,
		},
	}

	tests := []struct {
		name          string
		inputs        *gatewayapi.WorkflowInputs
		arbitraryJSON *gatewayapi.WorkflowArbitraryJSON
		field         string
	}{
		{
			name:   "typed inputs",
			inputs: &inputs,
		},
		{
			name: "arbitrary json",
			arbitraryJSON: &gatewayapi.WorkflowArbitraryJSON{
				Description:    &description,
				DefaultPayload: &defaultPayload,
			},
		},
		{
			name:   "both modes",
			inputs: &inputs,
			arbitraryJSON: &gatewayapi.WorkflowArbitraryJSON{
				Description: &description,
			},
			field: "arbitrary_json",
		},
		{
			name: "empty arbitrary json description",
			arbitraryJSON: &gatewayapi.WorkflowArbitraryJSON{
				Description: &emptyDescription,
			},
			field: "arbitrary_json.description",
		},
		{
			name: "empty typed input name",
			inputs: &gatewayapi.WorkflowInputs{
				"": gatewayapi.WorkflowInputSchema{
					Type:     gatewayapi.String,
					Required: true,
				},
			},
			field: "inputs.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			issues, err := ValidateDefinition(tt.inputs, tt.arbitraryJSON)
			if err != nil {
				t.Fatalf("ValidateDefinition() error = %v", err)
			}
			if tt.field == "" {
				if len(issues) != 0 {
					t.Fatalf("ValidateDefinition() issues = %#v, want none", issues)
				}
				return
			}
			if len(issues) == 0 {
				t.Fatalf("ValidateDefinition() issues = nil, want field %q", tt.field)
			}
			if issues[0].Field != tt.field {
				t.Fatalf("ValidateDefinition() field = %q, want %q", issues[0].Field, tt.field)
			}
		})
	}
}

func TestValidateValues(t *testing.T) {
	description := "payload"
	inputs := gatewayapi.WorkflowInputs{
		"target": gatewayapi.WorkflowInputSchema{
			Type:     gatewayapi.String,
			Required: true,
		},
	}
	arbitraryJSON := gatewayapi.WorkflowArbitraryJSON{
		Description: &description,
	}

	tests := []struct {
		name          string
		raw           []byte
		inputs        *gatewayapi.WorkflowInputs
		arbitraryJSON *gatewayapi.WorkflowArbitraryJSON
		field         string
	}{
		{
			name:   "typed object",
			raw:    []byte(`{"target":"repo"}`),
			inputs: &inputs,
		},
		{
			name:  "typed object without declared inputs",
			raw:   []byte(`{"target":"repo"}`),
			field: "inputs",
		},
		{
			name:   "typed array",
			raw:    []byte(`[1,2,3]`),
			inputs: &inputs,
			field:  "inputs",
		},
		{
			name:   "typed missing required field",
			raw:    []byte(`{}`),
			inputs: &inputs,
			field:  "inputs",
		},
		{
			name:   "typed null without declared inputs",
			raw:    []byte(`null`),
			inputs: nil,
		},
		{
			name:          "arbitrary object",
			raw:           []byte(`{"target":"repo"}`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary array",
			raw:           []byte(`[1,2,3]`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary string",
			raw:           []byte(`"repo"`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary number",
			raw:           []byte(`42`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary boolean",
			raw:           []byte(`true`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary null",
			raw:           []byte(`null`),
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary empty",
			raw:           nil,
			arbitraryJSON: &arbitraryJSON,
		},
		{
			name:          "arbitrary invalid json",
			raw:           []byte(`{"target"`),
			arbitraryJSON: &arbitraryJSON,
			field:         "inputs",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			issues, err := ValidateValues(tt.raw, tt.inputs, tt.arbitraryJSON, "inputs")
			if err != nil {
				t.Fatalf("ValidateValues() error = %v", err)
			}
			if tt.field == "" {
				if len(issues) != 0 {
					t.Fatalf("ValidateValues() issues = %#v, want none", issues)
				}
				return
			}
			if len(issues) == 0 {
				t.Fatalf("ValidateValues() issues = nil, want field %q", tt.field)
			}
			if issues[0].Field != tt.field {
				t.Fatalf("ValidateValues() field = %q, want %q", issues[0].Field, tt.field)
			}
		})
	}
}
