package workflow

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"maps"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const draft202012SchemaURL = "https://json-schema.org/draft/2020-12/schema"

//go:embed input-schema.json
var workflowInputDefinitionSchema []byte

var loadDefinitionSchema = sync.OnceValues(func() (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(workflowInputDefinitionSchema))
	if err != nil {
		return nil, fmt.Errorf("decode workflow input definition schema: %w", err)
	}

	schema, err := compileSchema("workflow-input-definition.json", doc)
	if err != nil {
		return nil, fmt.Errorf("compile workflow input definition schema: %w", err)
	}

	return schema, nil
})

// Issue reports one workflow input contract validation failure.
type Issue struct {
	Field   string
	Message string
}

// ValidateDefinition validates one workflow input contract definition.
func ValidateDefinition(inputs *gatewayapi.WorkflowInputs, fieldPrefix string) ([]Issue, error) {
	if inputs == nil {
		return nil, nil
	}

	definitionSchema, err := loadDefinitionSchema()
	if err != nil {
		return nil, err
	}

	keys := mapsKeys(*inputs)
	issues := make([]Issue, 0, len(keys))

	for _, name := range keys {
		schema := (*inputs)[name]
		inputField := fieldPrefix + "." + name

		if strings.TrimSpace(name) == "" {
			issues = append(issues, Issue{
				Field:   inputField,
				Message: "input name must not be empty",
			})
			continue
		}

		doc, err := schemaDocument(schema)
		if err != nil {
			return nil, fmt.Errorf("marshal workflow input schema %q: %w", name, err)
		}

		inputIssues := append(
			validateValue(definitionSchema, doc, inputField),
			validateSchemaRelationships(schema, inputField)...,
		)
		issues = append(issues, inputIssues...)
		if len(inputIssues) > 0 {
			continue
		}

		valueSchema, err := compileSchema(
			fmt.Sprintf("workflow-input-%s.json", name),
			valueSchemaDocument(doc),
		)
		if err != nil {
			issues = append(issues, Issue{
				Field:   inputField,
				Message: err.Error(),
			})
			continue
		}

		if value, ok := doc["default"]; ok {
			issues = append(
				issues,
				validateValue(valueSchema, value, inputField+".default")...,
			)
		}

		enumValues, ok := doc["enum"].([]any)
		if !ok {
			continue
		}

		for i, value := range enumValues {
			issues = append(
				issues,
				validateValue(
					valueSchema,
					value,
					inputField+".enum."+strconv.Itoa(i),
				)...,
			)
		}
	}

	return issues, nil
}

// ValidateValues validates runtime inputs against one workflow input contract.
func ValidateValues(raw []byte, inputs *gatewayapi.WorkflowInputs, fieldPrefix string) ([]Issue, error) {
	value, err := decodeValues(raw)
	if err != nil {
		return []Issue{{
			Field:   fieldPrefix,
			Message: err.Error(),
		}}, nil
	}

	if inputs == nil || len(*inputs) == 0 {
		if len(value) == 0 {
			return nil, nil
		}

		return []Issue{{
			Field:   fieldPrefix,
			Message: "must be empty because the workflow declares no inputs",
		}}, nil
	}

	schemaDoc, err := objectSchemaDocument(*inputs)
	if err != nil {
		return nil, fmt.Errorf("build workflow input contract: %w", err)
	}

	schema, err := compileSchema("workflow-inputs.json", schemaDoc)
	if err != nil {
		return nil, fmt.Errorf("compile workflow input contract: %w", err)
	}

	return validateValue(schema, value, fieldPrefix), nil
}

func compileSchema(name string, doc any) (*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()

	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("encode schema: %w", err)
	}

	normalized, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("decode schema: %w", err)
	}

	if err := compiler.AddResource(name, normalized); err != nil {
		return nil, fmt.Errorf("load schema: %w", err)
	}

	schema, err := compiler.Compile(name)
	if err != nil {
		return nil, fmt.Errorf("compile schema: %w", err)
	}

	return schema, nil
}

func decodeValues(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return map[string]any{}, nil
	}

	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("must be valid json")
	}
	if value == nil {
		return map[string]any{}, nil
	}

	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("must be a json object")
	}

	return object, nil
}

func mapsKeys[M ~map[string]V, V any](m M) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func objectSchemaDocument(inputs gatewayapi.WorkflowInputs) (map[string]any, error) {
	properties := make(map[string]any, len(inputs))
	required := make([]string, 0, len(inputs))

	for _, name := range mapsKeys(inputs) {
		schema := inputs[name]
		if schema.Required {
			required = append(required, name)
		}

		valueSchemaDoc, err := schemaDocument(schema)
		if err != nil {
			return nil, fmt.Errorf(
				"build workflow input value schema %q: %w",
				name,
				err,
			)
		}
		properties[name] = valueSchemaDocument(valueSchemaDoc)
	}

	schemaDoc := map[string]any{
		"$schema":              draft202012SchemaURL,
		"type":                 "object",
		"additionalProperties": false,
		"properties":           properties,
	}
	if len(required) > 0 {
		schemaDoc["required"] = required
	}

	return schemaDoc, nil
}

func schemaDocument(schema gatewayapi.WorkflowInputSchema) (map[string]any, error) {
	raw, err := json.Marshal(schema)
	if err != nil {
		return nil, fmt.Errorf("encode schema: %w", err)
	}

	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("decode schema: %w", err)
	}

	object, ok := doc.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema must be a json object")
	}

	return object, nil
}

func valueSchemaDocument(doc map[string]any) map[string]any {
	schema := maps.Clone(doc)
	schema["$schema"] = draft202012SchemaURL
	delete(schema, "required")
	return schema
}

func validateSchemaRelationships(schema gatewayapi.WorkflowInputSchema, fieldPrefix string) []Issue {
	issues := []Issue{}

	if schema.MinLength != nil && schema.MaxLength != nil && *schema.MinLength > *schema.MaxLength {
		issues = append(issues, Issue{
			Field:   fieldPrefix,
			Message: "minLength must be less than or equal to maxLength",
		})
	}

	if schema.Minimum != nil && schema.Maximum != nil && *schema.Minimum > *schema.Maximum {
		issues = append(issues, Issue{
			Field:   fieldPrefix,
			Message: "minimum must be less than or equal to maximum",
		})
	}

	if schema.ExclusiveMinimum != nil && schema.ExclusiveMaximum != nil && *schema.ExclusiveMinimum >= *schema.ExclusiveMaximum {
		issues = append(issues, Issue{
			Field:   fieldPrefix,
			Message: "exclusiveMinimum must be less than exclusiveMaximum",
		})
	}

	return issues
}

func validateValue(schema *jsonschema.Schema, value any, fieldPrefix string) []Issue {
	err := schema.Validate(value)
	if err == nil {
		return nil
	}

	verr, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return []Issue{{
			Field:   fieldPrefix,
			Message: err.Error(),
		}}
	}

	output := verr.BasicOutput()
	if len(output.Errors) == 0 && output.Error != nil {
		return []Issue{{
			Field:   joinField(fieldPrefix, output.InstanceLocation),
			Message: output.Error.String(),
		}}
	}

	issues := make([]Issue, 0, len(output.Errors))
	for _, item := range output.Errors {
		if item.Error == nil {
			continue
		}
		if isValidationNoise(item.Error.String()) {
			continue
		}

		issues = append(issues, Issue{
			Field:   joinField(fieldPrefix, item.InstanceLocation),
			Message: item.Error.String(),
		})
	}
	if len(issues) > 0 {
		return issues
	}

	for _, item := range output.Errors {
		if item.Error == nil {
			continue
		}

		issues = append(issues, Issue{
			Field:   joinField(fieldPrefix, item.InstanceLocation),
			Message: item.Error.String(),
		})
	}

	return issues
}

func joinField(fieldPrefix string, instanceLocation string) string {
	var field strings.Builder
	field.WriteString(fieldPrefix)
	for _, part := range jsonPointerParts(instanceLocation) {
		field.WriteString(".")
		field.WriteString(part)
	}
	return field.String()
}

func jsonPointerParts(ptr string) []string {
	if ptr == "" || ptr == "/" {
		return nil
	}

	parts := strings.Split(strings.TrimPrefix(ptr, "/"), "/")
	out := make([]string, 0, len(parts))

	for _, part := range parts {
		part = strings.ReplaceAll(part, "~1", "/")
		part = strings.ReplaceAll(part, "~0", "~")
		out = append(out, part)
	}

	return out
}

func isValidationNoise(message string) bool {
	switch message {
	case "'allOf' failed", "'anyOf' failed", "'oneOf' failed", "'not' failed":
		return true
	default:
		return false
	}
}
