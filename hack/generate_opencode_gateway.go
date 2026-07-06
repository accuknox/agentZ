package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"sigs.k8s.io/yaml"
)

const (
	baseSpecPath      = "openapi/base.yaml"
	outputSpecPath    = "openapi/gateway.yaml"
	routeManifestPath = "internal/gateway/opencode.routes.gen.go"
	upstreamSpecURL   = "https://raw.githubusercontent.com/anomalyco/opencode/refs/tags/v1.14.46/packages/sdk/openapi.json"
	opencodePrefix    = "/api/opencode/{agentName}"
	opencodeNS        = "Opencode"
)

type routeManifest struct {
	Routes []routeSpec `json:"routes"`
}

type routeSpec struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "generate opencode gateway spec: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	base, err := readYAML(baseSpecPath)
	if err != nil {
		return err
	}

	upstream, err := fetchJSON(upstreamSpecURL)
	if err != nil {
		return err
	}

	rewriteOpenAPI31Keywords(upstream)
	applyOAPICodegenFixups(upstream)
	rewritten, manifest, err := rewriteOpenCode(upstream)
	if err != nil {
		return err
	}

	mergeSpec(base, rewritten)

	if err := writeYAML(outputSpecPath, base); err != nil {
		return err
	}
	if err := writeRoutesGo(routeManifestPath, manifest); err != nil {
		return err
	}
	return nil
}

func readYAML(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read base spec: %w", err)
	}

	var out map[string]any
	if err := yaml.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode base spec: %w", err)
	}
	return out, nil
}

func fetchJSON(rawURL string) (map[string]any, error) {
	resp, err := http.Get(rawURL)
	if err != nil {
		return nil, fmt.Errorf("fetch upstream spec: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch upstream spec: unexpected status %s", resp.Status)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read upstream spec: %w", err)
	}

	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode upstream spec: %w", err)
	}
	return out, nil
}

func rewriteOpenCode(doc map[string]any) (map[string]any, routeManifest, error) {
	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return nil, routeManifest{}, fmt.Errorf("upstream spec has no paths")
	}

	components, _ := doc["components"].(map[string]any)
	refMap := buildRefMap(components)
	rewriteRefs(doc, refMap)

	filteredPaths := make(map[string]any)
	manifest := routeManifest{Routes: make([]routeSpec, 0)}
	for path, itemAny := range paths {
		item, ok := itemAny.(map[string]any)
		if !ok {
			continue
		}

		filteredItem := maps.Clone(item)
		filteredItem["parameters"] = prependAgentParameter(filteredItem["parameters"])
		gatewayPath := opencodePrefix + path
		filteredPaths[gatewayPath] = filteredItem

		for _, method := range pathMethods(filteredItem) {
			manifest.Routes = append(manifest.Routes, routeSpec{
				Method: strings.ToUpper(method),
				Path:   gatewayPath,
			})
		}
	}

	slices.SortFunc(manifest.Routes, func(a, b routeSpec) int {
		if a.Path == b.Path {
			return strings.Compare(a.Method, b.Method)
		}
		return strings.Compare(a.Path, b.Path)
	})

	return map[string]any{
		"openapi": "3.0.3",
		"paths":   filteredPaths,
		"components": map[string]any{
			"schemas":         namespaceBucket(componentBucket(components, "schemas")),
			"parameters":      namespaceBucket(componentBucket(components, "parameters")),
			"responses":       namespaceBucket(componentBucket(components, "responses")),
			"requestBodies":   namespaceBucket(componentBucket(components, "requestBodies")),
			"headers":         namespaceBucket(componentBucket(components, "headers")),
			"examples":        namespaceBucket(componentBucket(components, "examples")),
			"securitySchemes": namespaceBucket(componentBucket(components, "securitySchemes")),
			"links":           namespaceBucket(componentBucket(components, "links")),
			"callbacks":       namespaceBucket(componentBucket(components, "callbacks")),
		},
		"tags": filterTags(doc["tags"], filteredPaths),
	}, manifest, nil
}

func buildRefMap(components map[string]any) map[string]string {
	out := make(map[string]string)
	for _, bucket := range []string{
		"schemas",
		"parameters",
		"responses",
		"requestBodies",
		"headers",
		"examples",
		"securitySchemes",
		"links",
		"callbacks",
	} {
		items := componentBucket(components, bucket)
		for name := range items {
			oldRef := "#/components/" + bucket + "/" + name
			newRef := "#/components/" + bucket + "/" + opencodeNS + name
			out[oldRef] = newRef
		}
	}
	return out
}

func rewriteRefs(value any, refs map[string]string) {
	switch node := value.(type) {
	case map[string]any:
		if raw, ok := node["$ref"].(string); ok {
			if next, found := refs[raw]; found {
				node["$ref"] = next
			}
		}
		for _, child := range node {
			rewriteRefs(child, refs)
		}
	case []any:
		for _, child := range node {
			rewriteRefs(child, refs)
		}
	}
}

func mergeSpec(base, extra map[string]any) {
	appendTags(base, extra["tags"])
	mergeMapBucket(base, extra, "paths")

	baseComponents := ensureMap(base, "components")
	extraComponents, _ := extra["components"].(map[string]any)
	buckets := []string{
		"schemas",
		"parameters",
		"responses",
		"requestBodies",
		"headers",
		"examples",
		"securitySchemes",
		"links",
		"callbacks",
	}
	for _, bucket := range buckets {
		baseBucket := ensureMap(baseComponents, bucket)
		extraBucket, _ := extraComponents[bucket].(map[string]any)
		maps.Copy(baseBucket, extraBucket)
	}
}

func appendTags(base map[string]any, tagsAny any) {
	baseTags, _ := base["tags"].([]any)
	extraTags, _ := tagsAny.([]any)
	seen := make(map[string]struct{}, len(baseTags))

	for _, item := range baseTags {
		tag, _ := item.(map[string]any)
		name, _ := tag["name"].(string)
		if name != "" {
			seen[name] = struct{}{}
		}
	}

	for _, item := range extraTags {
		tag, _ := item.(map[string]any)
		name, _ := tag["name"].(string)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		baseTags = append(baseTags, item)
		seen[name] = struct{}{}
	}

	base["tags"] = baseTags
}

func filterTags(tagsAny any, paths map[string]any) []any {
	used := make(map[string]struct{})
	for _, itemAny := range paths {
		item, _ := itemAny.(map[string]any)
		for _, method := range pathMethods(item) {
			op, _ := item[method].(map[string]any)
			for _, tag := range stringSlice(op["tags"]) {
				used[tag] = struct{}{}
			}
		}
	}

	items, _ := tagsAny.([]any)
	out := make([]any, 0, len(items))
	for _, item := range items {
		tag, _ := item.(map[string]any)
		name, _ := tag["name"].(string)
		if _, ok := used[name]; !ok {
			continue
		}
		out = append(out, item)
	}
	return out
}

func pathMethods(item map[string]any) []string {
	var out []string
	methods := []string{
		"get",
		"post",
		"put",
		"patch",
		"delete",
		"head",
		"options",
	}
	for _, method := range methods {
		if _, ok := item[method]; ok {
			out = append(out, method)
		}
	}
	return out
}

func ensureMap(parent map[string]any, key string) map[string]any {
	if existing, ok := parent[key].(map[string]any); ok {
		return existing
	}
	out := make(map[string]any)
	parent[key] = out
	return out
}

func mergeMapBucket(base, extra map[string]any, key string) {
	baseMap := ensureMap(base, key)
	extraMap, _ := extra[key].(map[string]any)
	maps.Copy(baseMap, extraMap)
}

func componentBucket(components map[string]any, key string) map[string]any {
	bucket, _ := components[key].(map[string]any)
	if bucket == nil {
		return map[string]any{}
	}
	return bucket
}

func namespaceBucket(bucket map[string]any) map[string]any {
	out := make(map[string]any, len(bucket))
	for key, value := range bucket {
		out[opencodeNS+key] = value
	}
	return out
}

func prependAgentParameter(value any) []any {
	params, _ := value.([]any)

	out := make([]any, 0, len(params)+1)
	out = append(out, map[string]any{
		"name":        "agentName",
		"in":          "path",
		"required":    true,
		"description": "AgentZ agent name.",
		"schema": map[string]any{
			"type":      "string",
			"maxLength": 32,
			"pattern":   "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
		},
	})
	out = append(out, params...)
	return out
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, _ := item.(string)
		if text == "" {
			continue
		}
		out = append(out, text)
	}
	return out
}

func rewriteOpenAPI31Keywords(value any) {
	switch node := value.(type) {
	case map[string]any:
		if raw, ok := node["exclusiveMinimum"]; ok {
			if num, ok := raw.(float64); ok {
				if _, exists := node["minimum"]; !exists {
					node["minimum"] = num
				}
				node["exclusiveMinimum"] = true
			}
		}
		if prefixItems, ok := node["prefixItems"].([]any); ok {
			if len(prefixItems) > 0 {
				node["items"] = map[string]any{}
			}
			delete(node, "prefixItems")
		}
		rewriteNullableSchema(node)
		rewritePrimitiveUnion(node)

		for _, child := range node {
			rewriteOpenAPI31Keywords(child)
		}
	case []any:
		for _, child := range node {
			rewriteOpenAPI31Keywords(child)
		}
	}
}

func rewriteNullableSchema(node map[string]any) {
	for _, key := range []string{"anyOf", "oneOf"} {
		items, ok := node[key].([]any)
		if !ok {
			continue
		}

		nonNull, nullable := splitNullableUnion(items)
		if !nullable {
			continue
		}

		node["nullable"] = true
		if len(nonNull) == 1 {
			schema, ok := nonNull[0].(map[string]any)
			if !ok {
				continue
			}
			delete(node, key)
			maps.Copy(node, schema)
			continue
		}

		node[key] = nonNull
	}

	types, ok := node["type"].([]any)
	if !ok {
		return
	}

	var nullable bool
	filtered := make([]any, 0, len(types))
	for _, item := range types {
		text, _ := item.(string)
		if text == "null" {
			nullable = true
			continue
		}
		filtered = append(filtered, item)
	}
	if !nullable {
		return
	}

	node["nullable"] = true
	switch len(filtered) {
	case 0:
		delete(node, "type")
	case 1:
		node["type"] = filtered[0]
	default:
		node["type"] = filtered
	}
}

func splitNullableUnion(items []any) ([]any, bool) {
	nonNull := make([]any, 0, len(items))
	var nullable bool

	for _, item := range items {
		schema, ok := item.(map[string]any)
		if !ok {
			nonNull = append(nonNull, item)
			continue
		}
		if schemaType, _ := schema["type"].(string); schemaType == "null" {
			nullable = true
			continue
		}
		nonNull = append(nonNull, item)
	}

	return nonNull, nullable
}

func rewritePrimitiveUnion(node map[string]any) {
	for _, key := range []string{"anyOf", "oneOf"} {
		items, ok := node[key].([]any)
		if !ok {
			continue
		}

		primitiveType, ok := samePrimitiveUnion(items)
		if !ok {
			continue
		}

		delete(node, key)
		node["type"] = primitiveType
	}
}

func samePrimitiveUnion(items []any) (string, bool) {
	if len(items) == 0 {
		return "", false
	}

	var primitiveType string
	for _, item := range items {
		schema, ok := item.(map[string]any)
		if !ok {
			return "", false
		}

		schemaType, _ := schema["type"].(string)
		switch schemaType {
		case "boolean", "integer", "number", "string":
		default:
			return "", false
		}

		if primitiveType == "" {
			primitiveType = schemaType
			continue
		}
		if primitiveType != schemaType {
			return "", false
		}
	}

	return primitiveType, true
}

func applyOAPICodegenFixups(doc map[string]any) {
	schemas := componentBucket(ensureMap(doc, "components"), "schemas")

	renameSchema(schemas, "EventTuiCommandExecute", "OpencodeTUICommandExecuteEvent")
	renameSchema(schemas, "EventTuiPromptAppend", "OpencodeTUIPromptAppendEvent")
	renameSchema(schemas, "EventTuiSessionSelect", "OpencodeTUISessionSelectEvent")
	renameSchema(schemas, "EventTuiToastShow", "OpencodeTUIToastShowEvent")
	renameSchema(schemas, "EventTuiToastShow1", "OpencodeTUIToastShowAltEvent")
}

func renameSchema(schemas map[string]any, name string, goName string) {
	schema, ok := schemas[name].(map[string]any)
	if !ok {
		return
	}
	schema["x-go-name"] = goName
}

func writeYAML(path string, doc map[string]any) error {
	raw, err := yaml.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode combined spec: %w", err)
	}
	return os.WriteFile(path, raw, 0o644)
}

func writeRoutesGo(path string, manifest routeManifest) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}

	var buf bytes.Buffer
	buf.WriteString("package gateway\n\n")
	buf.WriteString("// Code generated by hack/generate_opencode_gateway.go. DO NOT EDIT.\n")
	buf.WriteString("var opencodeRoutes = []opencodeRoute{\n")
	for _, route := range manifest.Routes {
		fmt.Fprintf(&buf, "\t{Method: %q, Path: %q},\n",
			route.Method, route.Path)
	}
	buf.WriteString("}\n")

	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write route source: %w", err)
	}
	return nil
}
