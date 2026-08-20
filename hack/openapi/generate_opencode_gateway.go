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
	upstreamSpecURL   = "https://raw.githubusercontent.com/anomalyco/opencode/refs/tags/v1.18.16/packages/sdk/openapi.json"
	opencodePrefix    = "/api/opencode/{agentName}"
	opencodeNS        = "Opencode"
)

type routeManifest struct {
	Routes []routeSpec `json:"routes"`
}

type routeSpec struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Operation string `json:"operation"`
}

type operationCapability struct {
	Scheme string
	Scope  string
}

var baseOperationCapabilities = map[string][]string{
	"agent.author": {
		"createAgent",
	},
	"agent.delete_shared_secret": {
		"deleteSecret",
	},
	"agent.read_shared_secret": {
		"listSecrets", "watchSecrets",
	},
	"agent.use_shared": {
		"createAgentDirectory",
		"createAgentFile",
		"createWorkflow",
		"createWorkflowRun",
		"createWorkflowSchedule",
		"deleteAgent",
		"deleteAgentEntry",
		"deleteAgentMutableSkills",
		"deleteAgentShare",
		"deleteWorkflowRun",
		"deleteWorkflows",
		"deleteWorkflowSchedule",
		"exportAgentMutableSkills",
		"getChatSessionPreference",
		"importMutableSkills",
		"getAgentOwner",
		"getWorkflow",
		"getWorkflowRun",
		"listAgents",
		"listChatSessions",
		"listAgentAccessTargets",
		"listAgentMutableSkills",
		"listAgentShares",
		"listAgentWorkflowSchedules",
		"previewMutableSkillImport",
		"listWorkflowRuns",
		"listWorkflowSchedules",
		"listWorkflowSummaries",
		"listWorkflowWebhookTriggers",
		"readAgentFile",
		"readAgentFileRaw",
		"renameAgentEntry",
		"statAgentFile",
		"transferAgentOwner",
		"updateAgent",
		"updateChatSessionPreference",
		"updateWorkflowSchedule",
		"upsertAgentShare",
		"watchAgents",
		"watchChatSessions",
		"watchWorkflowRuns",
		"writeAgentFile",
		"writeAgentFileRaw",
	},
	"agent.write_shared_secret": {
		"putSecret",
	},
	"api_key.workflow_invoke": {
		"invokeWorkflowWebhook",
	},
	"inference_pool.create": {
		"createInferencePool",
	},
	"inference_pool.delete": {
		"deleteInferencePool",
	},
	"inference_pool.modify": {
		"updateInferencePool",
	},
	"inference_pool.read": {
		"getInferencePool",
		"getInferencePoolUsage",
		"listInferencePools",
		"watchInferencePools",
	},
	"inference_provider.create": {
		"createInferenceProvider",
		"createInferenceProviderOAuthTicket",
	},
	"inference_provider.delete": {
		"deleteInferenceProvider",
	},
	"inference_provider.modify": {
		"updateInferenceProvider",
	},
	"inference_provider.read": {
		"getInferenceProvider",
		"getInferenceProviderUsage",
		"listInferenceModelSuggestions",
		"listInferenceProviderCatalog",
		"listInferenceProviders",
		"refreshInferenceProviderModels",
		"watchInferenceProviders",
	},
	"mcp_connection.create": {
		"createMCPConnection",
	},
	"mcp_connection.delete": {
		"deleteMCPConnection",
	},
	"mcp_connection.read": {
		"getMCPConnection",
		"listMCPConnections",
		"watchMCPConnections",
	},
	"observability.read": {
		"getEventTrailEvent",
		"getMCPGraph",
		"getSpanDetail",
		"listEventTrailEvents",
		"listFileObservability",
		"listFileObservabilitySummary",
		"listNetworkObservability",
		"listNetworkObservabilitySummary",
		"listProcessObservability",
		"listProcessObservabilitySummary",
		"listSpans",
		"listTraceSessions",
	},
	"organization.administer": {
		"createWorkspace",
		"listWorkspaceInheritedResources",
		"listWorkspaceMemberCandidates",
		"replaceWorkspaceInheritedResources",
		"retryWorkspace",
		"updateWorkspaceLifecycle",
	},
	"organization.member": {
		"ensureTenant",
		"getTenant",
		"getWorkspace",
		"listWorkspaces",
		"resolveWorkspaceSlug",
	},
	"sandbox.create": {
		"createSandbox",
	},
	"sandbox.delete": {
		"deleteSandbox",
	},
	"sandbox.modify": {
		"updateSandbox",
	},
	"sandbox.read": {
		"listSandboxes",
	},
	"skill.create": {
		"createSkill",
		"importImmutableSkills",
	},
	"skill.delete": {
		"deleteImmutableSkills",
		"deleteSkill",
	},
	"skill.modify": {
		"updateSkill",
	},
	"skill.read": {
		"exportImmutableSkills",
		"getSkillReferences",
		"listImmutableSkillSummaries",
		"listImmutableSkillVersions",
		"listSkills",
		"previewImmutableSkillImport",
	},
	"workflow_run.report": {
		"patchWorkflowRunNodeStatus",
		"patchWorkflowRunStatus",
	},
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
	if err := applyBaseCapabilities(base); err != nil {
		return err
	}

	upstream, err := fetchJSON(upstreamSpecURL)
	if err != nil {
		return err
	}

	rewriteOpenAPI31Keywords(upstream)
	if err := applyOAPICodegenFixups(upstream); err != nil {
		return err
	}
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
			op, ok := filteredItem[method].(map[string]any)
			if !ok {
				return nil, routeManifest{}, fmt.Errorf("%s %s is not an operation", method, path)
			}
			operationID, ok := op["operationId"].(string)
			if !ok {
				return nil, routeManifest{}, fmt.Errorf("%s %s has no operationId", method, path)
			}
			operation, capability, err := opencodeOperation(operationID)
			if err != nil {
				return nil, routeManifest{}, fmt.Errorf("map %s %s: %w", method, path, err)
			}
			op["security"] = []any{map[string]any{
				"GatewayBearer": []any{capability},
			}}
			manifest.Routes = append(manifest.Routes, routeSpec{
				Method:    strings.ToUpper(method),
				Path:      gatewayPath,
				Operation: operation,
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

func applyBaseCapabilities(doc map[string]any) error {
	capabilities := make(map[string]operationCapability)
	for scope, operations := range baseOperationCapabilities {
		scheme := "GatewayBearer"
		if strings.HasPrefix(scope, "api_key.") {
			scheme = "GatewayAPIKey"
		}
		for _, operation := range operations {
			if _, exists := capabilities[operation]; exists {
				return fmt.Errorf("base operation %q has multiple capability mappings", operation)
			}
			capabilities[operation] = operationCapability{Scheme: scheme, Scope: scope}
		}
	}

	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return fmt.Errorf("base spec has no paths")
	}
	seen := make(map[string]struct{})
	for path, itemAny := range paths {
		item, ok := itemAny.(map[string]any)
		if !ok {
			return fmt.Errorf("base path %s is not a path item", path)
		}
		for _, method := range pathMethods(item) {
			op, ok := item[method].(map[string]any)
			if !ok {
				return fmt.Errorf("base operation %s %s is invalid", method, path)
			}
			operation, ok := op["operationId"].(string)
			if !ok || strings.TrimSpace(operation) == "" {
				return fmt.Errorf("base operation %s %s has no operationId", method, path)
			}
			capability, mapped := capabilities[operation]
			if !mapped {
				return fmt.Errorf("base operation %s %s (%q) has no capability mapping", method, path, operation)
			}
			op["security"] = []any{map[string]any{
				capability.Scheme: []any{capability.Scope},
			}}
			seen[operation] = struct{}{}
		}
	}
	for operation := range capabilities {
		if _, ok := seen[operation]; !ok {
			return fmt.Errorf("capability mapping references missing base operation %q", operation)
		}
	}
	return nil
}

func opencodeOperation(operationID string) (string, string, error) {
	switch operationID {
	case "provider.auth",
		"v2.integration.list",
		"v2.integration.get",
		"v2.integration.attempt.status":
		return "readSharedSecret", "agent.read_shared_secret", nil
	case "auth.set",
		"mcp.add",
		"mcp.auth.start",
		"mcp.auth.callback",
		"mcp.auth.authenticate",
		"provider.oauth.authorize",
		"provider.oauth.callback",
		"v2.integration.connect.key",
		"v2.integration.connect.oauth",
		"v2.integration.attempt.cancel",
		"v2.integration.attempt.complete",
		"v2.credential.update":
		return "writeSharedSecret", "agent.write_shared_secret", nil
	case "auth.remove", "mcp.auth.remove", "v2.credential.remove":
		return "deleteSharedSecret", "agent.delete_shared_secret", nil
	default:
		if strings.TrimSpace(operationID) == "" {
			return "", "", fmt.Errorf("upstream operationId is missing")
		}
		return "useSharedAgent", "agent.use_shared", nil
	}
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
		for key, child := range node {
			if raw, ok := child.(string); ok {
				if next, found := refs[raw]; found {
					node[key] = next
					continue
				}
			}
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

func applyOAPICodegenFixups(doc map[string]any) error {
	components, ok := doc["components"].(map[string]any)
	if !ok {
		return fmt.Errorf("upstream spec has no components")
	}
	schemas, ok := components["schemas"].(map[string]any)
	if !ok {
		return fmt.Errorf("upstream spec has no schemas")
	}
	schemas["PromptPartInput"] = map[string]any{
		"discriminator": map[string]any{
			"propertyName": "type",
			"mapping": map[string]any{
				"text":    "#/components/schemas/TextPartInput",
				"file":    "#/components/schemas/FilePartInput",
				"agent":   "#/components/schemas/AgentPartInput",
				"subtask": "#/components/schemas/SubtaskPartInput",
			},
		},
		"oneOf": []any{
			map[string]any{"$ref": "#/components/schemas/TextPartInput"},
			map[string]any{"$ref": "#/components/schemas/FilePartInput"},
			map[string]any{"$ref": "#/components/schemas/AgentPartInput"},
			map[string]any{"$ref": "#/components/schemas/SubtaskPartInput"},
		},
	}

	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return fmt.Errorf("upstream spec has no paths")
	}
	for _, path := range []string{
		"/session/{sessionID}/message",
		"/session/{sessionID}/prompt_async",
	} {
		item, ok := paths[path].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream spec has no %s path", path)
		}
		post, ok := item["post"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream spec has no POST %s operation", path)
		}
		requestBody, ok := post["requestBody"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s has no request body", path)
		}
		content, ok := requestBody["content"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s has no request content", path)
		}
		jsonBody, ok := content["application/json"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s has no JSON request body", path)
		}
		schema, ok := jsonBody["schema"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s has no request schema", path)
		}
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s request has no properties", path)
		}
		parts, ok := properties["parts"].(map[string]any)
		if !ok {
			return fmt.Errorf("upstream POST %s request has no parts", path)
		}
		parts["items"] = map[string]any{
			"$ref": "#/components/schemas/PromptPartInput",
		}
	}

	renameSchema(schemas, "EventTuiCommandExecute", "OpencodeTUICommandExecuteEvent")
	renameSchema(schemas, "EventTuiPromptAppend", "OpencodeTUIPromptAppendEvent")
	renameSchema(schemas, "EventTuiSessionSelect", "OpencodeTUISessionSelectEvent")
	renameSchema(schemas, "EventTuiToastShow", "OpencodeTUIToastShowEvent")
	renameSchema(schemas, "EventTuiToastShow1", "OpencodeTUIToastShowAltEvent")
	return nil
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
	buf.WriteString("// Code generated by hack/openapi. DO NOT EDIT.\n")
	buf.WriteString("var opencodeRoutes = []opencodeRoute{\n")
	for _, route := range manifest.Routes {
		fmt.Fprintf(&buf, "\t{Method: %q, Path: %q, Operation: %q},\n",
			route.Method, route.Path, route.Operation)
	}
	buf.WriteString("}\n")

	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write route source: %w", err)
	}
	return nil
}
