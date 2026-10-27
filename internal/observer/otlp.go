package observer

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"

	observerdb "github.com/accuknox/agentz/internal/observer/db"
)

var (
	errTraceAgentNameMissing       = errors.New("agentz.agent_name missing")
	errTraceSessionIDMissing       = errors.New("session.id missing")
	errTraceTenantNamespaceMissing = errors.New("tenant namespace missing")
)

const (
	attrAgentZAgentName       = "agentz.agent_name"
	attrAgentZTenantNamespace = "agentz.tenant_namespace"
	attrK8sNamespaceName      = "k8s.namespace.name"
	attrSessionID             = "session.id"
	attrServiceNamespace      = "service.namespace"
	attrSpanKind              = "openinference.span.kind"
	attrMCPMethodName         = "mcp.method.name"
	attrMCPSessionID          = "mcp.session.id"
	attrMCPConnectionName     = "mcp.connection.name"
	attrMCPDefaultTarget      = "mcp.target"
	attrMCPToolName           = "mcp.tool.name"
	attrGenAIToolName         = "gen_ai.tool.name"

	attrInputValue     = "input.value"
	attrInputMimeType  = "input.mime_type"
	attrOutputValue    = "output.value"
	attrOutputMimeType = "output.mime_type"

	attrLLMModelName       = "llm.model_name"
	attrLLMInputMessages   = "llm.input_messages"
	attrLLMOutputMessages  = "llm.output_messages"
	attrLLMTokenPrompt     = "llm.token_count.prompt"
	attrLLMTokenCompletion = "llm.token_count.completion"
	attrLLMTokenCacheRead  = "llm.token_count.prompt_details.cache_read"
	attrLLMTokenCacheWrite = "llm.token_count.prompt_details.cache_write"
	attrLLMCostTotal       = "llm.cost.total"
	attrLLMFinishReason    = "llm.finish_reason"
	attrGenAIRequestModel  = "gen_ai.request.model"
	attrGenAIResponseModel = "gen_ai.response.model"
	attrGenAIInputTokens   = "gen_ai.usage.input_tokens"
	attrGenAIOutputTokens  = "gen_ai.usage.output_tokens"
	attrGenAICacheRead     = "gen_ai.usage.cache_read.input_tokens"
	attrGenAICacheWrite    = "gen_ai.usage.cache_creation.input_tokens"

	attrToolName       = "tool.name"
	attrToolParameters = "tool.parameters"
	attrToolError      = "tool.error"

	attrErrorType    = "error.type"
	attrErrorMessage = "error.message"
	attrError        = "error"

	null        = "null"
	statusOK    = "OK"
	statusError = "ERROR"

	spanClassSession = "session"
	spanClassLLM     = "llm"
	spanClassTool    = "tool"

	operationSession     = "session"
	operationChat        = "chat"
	operationExecuteTool = "execute_tool"
)

type traceReceiver struct {
	tracev1.UnimplementedTraceServiceServer

	out   chan<- event
	stats *stats
	addr  string
	app   bool
}

type mcpToolResult struct {
	IsError bool `json:"isError"`
}

func (r *traceReceiver) run(ctx context.Context, cfg Config) error {
	lis, err := net.Listen("tcp", r.addr)
	if err != nil {
		return fmt.Errorf("listen otlp trace grpc %s: %w", r.addr, err)
	}

	maxMessageSize := cfg.OTLPTraceMaxMessageSize
	if maxMessageSize == 0 {
		maxMessageSize = DefaultOTLPTraceMaxMessageSize
	}
	srv := grpc.NewServer(grpc.MaxRecvMsgSize(maxMessageSize))
	tracev1.RegisterTraceServiceServer(srv, r)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting OTLP trace receiver", slog.String("addr", r.addr), slog.Bool("app", r.app))
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		// An unfinished export must not prevent accepted batches from draining.
		stop := time.AfterFunc(5*time.Second, srv.Stop)
		srv.GracefulStop()
		stop.Stop()
		err = <-errCh
	case err = <-errCh:
	}
	if err != nil && err != grpc.ErrServerStopped {
		return fmt.Errorf("serve otlp trace grpc: %w", err)
	}
	return nil
}

// Export queues valid spans and accounts for rejected telemetry.
func (r *traceReceiver) Export(ctx context.Context, req *tracev1.ExportTraceServiceRequest) (*tracev1.ExportTraceServiceResponse, error) {
	events, rejected := traceEventsFromOTLPRequest(req, r.app)
	for _, ev := range events {
		if err := sendEvent(ctx, r.out, ev); err != nil {
			return nil, err
		}
	}
	if rejected > 0 {
		atomic.AddUint64(&r.stats.filtered, uint64(rejected))
	}
	atomic.AddUint64(&r.stats.received, uint64(len(events)+rejected))
	if rejected > 0 {
		return &tracev1.ExportTraceServiceResponse{
			PartialSuccess: &tracev1.ExportTracePartialSuccess{
				RejectedSpans: int64(rejected),
				ErrorMessage:  "spans do not match the receiver scope or telemetry contract",
			},
		}, nil
	}
	return &tracev1.ExportTraceServiceResponse{}, nil
}

func traceEventsFromOTLPRequest(req *tracev1.ExportTraceServiceRequest, app bool) ([]event, int) {
	events := make([]event, 0)
	rejected := 0
	for _, rs := range req.GetResourceSpans() {
		resourceAttrs := attrsMap(rs.GetResource().GetAttributes())
		serviceName := resourceAttrs["service.name"].GetStringValue()
		gateway := false
		switch serviceName {
		case "agentz-oauth-gateway", "agentz-inference-gateway", "agentz-mcp-gateway":
			gateway = true
		}
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				// Attribution is accepted only on the network-isolated listener.
				// A resource label supplied to the native listener proves nothing.
				if gateway != app {
					rejected++
					continue
				}
				if gateway {
					evaluations, err := guardrailEventsFromSpan(sp)
					if err != nil {
						rejected++
						continue
					}
					for _, evaluation := range evaluations {
						events = append(events, event{guardrail: &evaluation})
					}
				}
				// The SDK owns model-operation traces. Native inference spans
				// supply guardrail evidence without adding duplicate operations.
				if serviceName == "agentz-inference-gateway" {
					continue
				}
				if serviceName == "agentz-oauth-gateway" {
					operation, err := appOperationFromOTLPSpan(sp)
					if err != nil {
						rejected++
						continue
					}
					events = append(events, event{app: &operation})
					continue
				}
				ev, err := traceEventFromOTLPSpan(sp, resourceAttrs)
				if err != nil {
					rejected++
					continue
				}
				events = append(events, event{trace: &ev})
			}
		}
	}
	return events, rejected
}

func appOperationFromOTLPSpan(sp *tracepb.Span) (observerdb.InsertAppOperationParams, error) {
	invalidSpan := sp.GetKind() != tracepb.Span_SPAN_KIND_SERVER ||
		len(sp.GetTraceId()) != 16 ||
		len(sp.GetSpanId()) != 8
	if invalidSpan {
		return observerdb.InsertAppOperationParams{}, errors.New("invalid app operation span")
	}
	attrs := attrsMap(sp.GetAttributes())
	operation := observerdb.InsertAppOperationParams{
		OrganizationID:    attrs["agentz.organization_id"].GetStringValue(),
		WorkspaceID:       attrs["agentz.workspace_id"].GetStringValue(),
		ClientID:          attrs["agentz.client_id"].GetStringValue(),
		AppName:           attrs["agentz.app_name"].GetStringValue(),
		GrantID:           attrs["agentz.grant_id"].GetStringValue(),
		UserID:            attrs["agentz.user_id"].GetStringValue(),
		ResourceKind:      attrs["agentz.resource_kind"].GetStringValue(),
		ResourceNamespace: attrs["agentz.resource_namespace"].GetStringValue(),
		ResourceName:      attrs["agentz.resource_name"].GetStringValue(),
		ResourceUid:       attrs["agentz.resource_uid"].GetStringValue(),
		TargetID:          attrs["agentz.target_id"].GetStringValue(),
		TraceID:           sp.GetTraceId(),
		SpanID:            sp.GetSpanId(),
		ParentSpanID:      append([]byte{}, sp.GetParentSpanId()...),
		StartTime:         unixNano(sp.GetStartTimeUnixNano()),
		EndTime:           unixNano(sp.GetEndTimeUnixNano()),
		Name:              sp.GetName(),
		StatusCode:        statusCode(sp.GetStatus()),
		ErrorType:         attrs[attrErrorType].GetStringValue(),
		ErrorMessage:      cmp.Or(attrs[attrErrorMessage].GetStringValue(), sp.GetStatus().GetMessage()),
		Model:             cmp.Or(attrs[attrGenAIResponseModel].GetStringValue(), attrs[attrGenAIRequestModel].GetStringValue()),
		ToolName:          attrs[attrGenAIToolName].GetStringValue(),
	}
	switch kind := attrs["agentz.agent_kind"].GetStringValue(); kind {
	case "claude", "codex":
		operation.AgentKind = kind
		// Composite B-tree keys include session, turn and call IDs together.
		// Bound each to 512 bytes, as for payload IDs in InsertAppOperation,
		// and retain observations without unusable optional labels.
		labels := map[string]*string{
			attrSessionID:         &operation.SessionID,
			"agentz.turn_id":      &operation.TurnID,
			"gen_ai.tool.call.id": &operation.ToolCallID,
		}
		for key, target := range labels {
			value := attrs[key].GetStringValue()
			if len(value) <= 512 {
				*target = value
			}
		}
	}
	identities := []string{
		operation.OrganizationID, operation.WorkspaceID, operation.ClientID,
		operation.GrantID, operation.UserID, operation.ResourceNamespace, operation.ResourceName,
		operation.ResourceUid, operation.TargetID,
	}
	for _, identity := range identities {
		if identity == "" {
			return operation, errors.New("app operation attribution is incomplete")
		}
	}
	operation.DurationNs = max(operation.EndTime.Sub(operation.StartTime).Nanoseconds(), 0)
	operation.InputMessages = jsonValue(anyValue(attrs[attrLLMInputMessages]))
	operation.OutputMessages = jsonValue(anyValue(attrs[attrLLMOutputMessages]))
	operation.ToolArguments = jsonValue(anyValue(attrs[attrToolParameters]))
	operation.ToolResult = jsonValue(anyValue(attrs[attrOutputValue]))
	operation.ToolError = jsonValue(anyValue(attrs[attrToolError]))
	switch operation.ResourceKind {
	case "inference":
		operation.SpanClass, operation.OperationName = spanClassLLM, operationChat
		usage := map[string]*pgtype.Int8{
			attrGenAIInputTokens:            &operation.InputTokens,
			attrGenAIOutputTokens:           &operation.OutputTokens,
			attrGenAICacheRead:              &operation.CachedInputTokens,
			attrGenAICacheWrite:             &operation.CachedWriteTokens,
			"gen_ai.usage.reasoning_tokens": &operation.ReasoningTokens,
		}
		for key, tokens := range usage {
			if value, ok := attrs[key]; ok {
				tokens.Int64, tokens.Valid = value.GetIntValue(), true
			}
		}
		if value, ok := attrs["agw.ai.usage.cost.total"]; ok {
			cost, err := strconv.ParseFloat(value.GetStringValue(), 64)
			if err != nil {
				return operation, fmt.Errorf("read app inference cost: %w", err)
			}
			operation.CostUsd = pgtype.Float8{Float64: cost, Valid: true}
		}
	case "mcp":
		if attrs[attrMCPMethodName].GetStringValue() != "tools/call" {
			return operation, errors.New("MCP discovery is not app tool activity")
		}
		operation.SpanClass, operation.OperationName = spanClassTool, operationExecuteTool
		var result mcpToolResult
		if hasPayloadValue(operation.ToolResult) {
			if err := json.Unmarshal(operation.ToolResult, &result); err != nil {
				return operation, fmt.Errorf("read MCP tool result: %w", err)
			}
		}
		if result.IsError || hasPayloadValue(operation.ToolError) || attrs["mcp.error.code"] != nil {
			operation.StatusCode = statusError
			operation.ErrorMessage = cmp.Or(operation.ErrorMessage, attrs["mcp.error.message"].GetStringValue())
		}
	default:
		return operation, errors.New("unsupported app resource kind")
	}
	requestFailed := attrs["http.response.status_code"].GetIntValue() >= 400 ||
		operation.ErrorType != "" ||
		operation.ErrorMessage != ""
	if requestFailed {
		operation.StatusCode = statusError
	}
	return operation, nil
}

func traceEventFromOTLPSpan(sp *tracepb.Span, resourceAttrs map[string]*commonpb.AnyValue) (traceSpanEvent, error) {
	if sp == nil || len(sp.GetTraceId()) != 16 || len(sp.GetSpanId()) != 8 {
		return traceSpanEvent{}, errTraceAgentNameMissing
	}

	spanAttrs := attrsMap(sp.GetAttributes())

	agentName := strings.TrimSpace(
		firstStringAttr(spanAttrs, resourceAttrs, attrAgentZAgentName),
	)
	if agentName == "" {
		return traceSpanEvent{}, errTraceAgentNameMissing
	}

	sessionID := cmp.Or(
		strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrSessionID)),
		strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrMCPSessionID)),
	)
	if sessionID == "" {
		return traceSpanEvent{}, errTraceSessionIDMissing
	}

	tenantNamespace := cmp.Or(
		strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrAgentZTenantNamespace)),
		strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrK8sNamespaceName)),
		strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrServiceNamespace)),
	)
	if tenantNamespace == "" {
		return traceSpanEvent{}, errTraceTenantNamespaceMissing
	}

	start := unixNano(sp.GetStartTimeUnixNano())
	end := unixNano(sp.GetEndTimeUnixNano())
	durationNS := max(end.Sub(start).Nanoseconds(), 0)

	spanClass, operationName := classifySpan(sp.GetName(), spanAttrs)
	status := statusCode(sp.GetStatus())
	errorMessage := cmp.Or(
		firstStringAttr(spanAttrs, resourceAttrs, attrErrorMessage),
		sp.GetStatus().GetMessage(),
		firstStringAttr(spanAttrs, resourceAttrs, attrError),
	)

	model := cmp.Or(
		spanAttrs[attrLLMModelName].GetStringValue(),
		spanAttrs[attrGenAIResponseModel].GetStringValue(),
		spanAttrs[attrGenAIRequestModel].GetStringValue(),
	)
	toolName := cmp.Or(
		spanAttrs[attrToolName].GetStringValue(),
		spanAttrs[attrGenAIToolName].GetStringValue(),
		spanAttrs[attrMCPToolName].GetStringValue(),
	)

	payload, strippedAttrs := extractSpanPayload(spanClass, spanAttrs)
	storedResourceAttrs := attrsForStorage(resourceAttrs)
	delete(storedResourceAttrs, "os.type")
	delete(storedResourceAttrs, "host.arch")
	resourceJSON := marshalJSON(storedResourceAttrs)
	spanJSON := marshalJSON(strippedAttrs)
	var mcpToolCall *mcpToolCallEvent
	if spanClass == spanClassTool && toolName != "" {
		connectionName := cmp.Or(
			spanAttrs[attrMCPConnectionName].GetStringValue(),
			spanAttrs[attrMCPDefaultTarget].GetStringValue(),
		)
		mcpToolName := cmp.Or(
			spanAttrs[attrMCPToolName].GetStringValue(),
			spanAttrs[attrGenAIToolName].GetStringValue(),
		)
		if connectionName != "" && mcpToolName != "" {
			failed := status == statusError
			if !failed {
				failed = hasPayloadValue(payload.toolError)
			}
			if !failed {
				result := mcpToolResult{}
				err := json.Unmarshal(payload.toolResult, &result)
				failed = err == nil && result.IsError
			}
			mcpToolCall = &mcpToolCallEvent{
				agentName:         agentName,
				traceID:           append([]byte{}, sp.GetTraceId()...),
				spanID:            append([]byte{}, sp.GetSpanId()...),
				startTime:         start,
				endTime:           end,
				durationNS:        durationNS,
				mcpConnectionName: connectionName,
				toolName:          mcpToolName,
				sessionID:         sessionID,
				failed:            failed,
			}
		}
	}

	return traceSpanEvent{
		tenantNamespace: tenantNamespace,
		agentName:       agentName,
		sessionID:       sessionID,
		traceID:         append([]byte{}, sp.GetTraceId()...),
		spanID:          append([]byte{}, sp.GetSpanId()...),
		parentSpanID:    append([]byte{}, sp.GetParentSpanId()...),
		startTime:       start,
		endTime:         end,
		durationNS:      durationNS,
		name:            sp.GetName(),
		spanClass:       spanClass,
		operationName:   operationName,
		kind:            spanKind(sp.GetKind()),
		statusCode:      status,
		errorType:       firstStringAttr(spanAttrs, resourceAttrs, attrErrorType),
		errorMessage:    errorMessage,
		model:           model,
		toolName:        toolName,
		inputTokens: cmp.Or(
			spanAttrs[attrLLMTokenPrompt].GetIntValue(),
			spanAttrs[attrGenAIInputTokens].GetIntValue(),
		),
		outputTokens: cmp.Or(
			spanAttrs[attrLLMTokenCompletion].GetIntValue(),
			spanAttrs[attrGenAIOutputTokens].GetIntValue(),
		),
		cachedInputTokens: cmp.Or(
			spanAttrs[attrLLMTokenCacheRead].GetIntValue(),
			spanAttrs[attrGenAICacheRead].GetIntValue(),
		),
		cachedWriteTokens: cmp.Or(
			spanAttrs[attrLLMTokenCacheWrite].GetIntValue(),
			spanAttrs[attrGenAICacheWrite].GetIntValue(),
		),
		costUSD:            attrFloat64(spanAttrs, attrLLMCostTotal),
		llmFinishReason:    spanAttrs[attrLLMFinishReason].GetStringValue(),
		resourceAttributes: resourceJSON,
		spanAttributes:     spanJSON,
		payload:            payload,
		mcpToolCall:        mcpToolCall,
	}, nil
}

func extractSpanPayload(spanClass string, attrs map[string]*commonpb.AnyValue) (traceSpanPayload, map[string]any) {
	out := attrsForStorage(attrs)
	// Captured guardrail evidence has its own permission and expiry contract.
	// Keeping it in generic span attributes would bypass event retention.
	delete(out, attrGuardrailEvaluations)
	inputMessages := []byte(null)
	outputMessages := []byte(null)
	if spanClass == spanClassLLM {
		inputMessages = extractJSONPayload(out, attrLLMInputMessages)
		outputMessages = extractJSONPayload(out, attrLLMOutputMessages)
	}

	toolArguments := []byte(null)
	toolResult := []byte(null)
	toolError := []byte(null)
	if spanClass == spanClassTool {
		toolArguments = extractJSONPayload(out, attrToolParameters)
		toolResult = extractJSONPayload(out, attrOutputValue)
		toolError = extractJSONPayload(out, attrToolError)

		delete(out, attrInputValue)
		delete(out, attrInputMimeType)
		delete(out, attrOutputMimeType)
	}

	return traceSpanPayload{
		inputMessages:  inputMessages,
		outputMessages: outputMessages,
		toolArguments:  toolArguments,
		toolResult:     toolResult,
		toolError:      toolError,
	}, out
}

func extractJSONPayload(attrs map[string]any, key string) []byte {
	v, ok := attrs[key]
	if !ok {
		return []byte(null)
	}
	delete(attrs, key)
	return jsonValue(v)
}

func classifySpan(name string, attrs map[string]*commonpb.AnyValue) (string, string) {
	switch strings.ToUpper(attrs[attrSpanKind].GetStringValue()) {
	case "AGENT":
		return spanClassSession, operationSession
	case "LLM":
		return spanClassLLM, operationChat
	case "TOOL":
		return spanClassTool, operationExecuteTool
	}

	switch {
	case name == "opencode.session":
		return spanClassSession, operationSession
	case name == "opencode.llm":
		return spanClassLLM, operationChat
	case strings.HasPrefix(name, "opencode.tool."):
		return spanClassTool, operationExecuteTool
	case attrs[attrMCPMethodName].GetStringValue() == "tools/call":
		return spanClassTool, operationExecuteTool
	case attrs[attrMCPToolName].GetStringValue() != "":
		return spanClassTool, operationExecuteTool
	case attrs[attrGenAIToolName].GetStringValue() != "":
		return spanClassTool, operationExecuteTool
	default:
		return "", ""
	}
}

func attrsMap(attrs []*commonpb.KeyValue) map[string]*commonpb.AnyValue {
	out := make(map[string]*commonpb.AnyValue, len(attrs))
	for _, attr := range attrs {
		if attr == nil || attr.Key == "" || attr.Value == nil {
			continue
		}
		out[attr.Key] = attr.Value
	}
	return out
}

func anyValue(v *commonpb.AnyValue) any {
	if v == nil {
		return nil
	}
	switch x := v.Value.(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue
	case *commonpb.AnyValue_IntValue:
		return x.IntValue
	case *commonpb.AnyValue_DoubleValue:
		return x.DoubleValue
	case *commonpb.AnyValue_BytesValue:
		return x.BytesValue
	case *commonpb.AnyValue_ArrayValue:
		items := x.ArrayValue.GetValues()
		out := make([]any, 0, len(items))
		for _, item := range items {
			out = append(out, anyValue(item))
		}
		return out
	case *commonpb.AnyValue_KvlistValue:
		out := make(map[string]any, len(x.KvlistValue.GetValues()))
		for _, item := range x.KvlistValue.GetValues() {
			if item == nil || item.Key == "" || item.Value == nil {
				continue
			}
			out[item.Key] = anyValue(item.Value)
		}
		return out
	default:
		return nil
	}
}

func jsonValue(v any) []byte {
	if v == nil {
		return []byte(null)
	}
	switch value := v.(type) {
	case []byte:
		if json.Valid(value) {
			return value
		}
	case string:
		raw := []byte(value)
		if json.Valid(raw) {
			return raw
		}
	}
	return marshalJSON(v)
}

func marshalJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		return []byte(null)
	}
	return data
}

func firstStringAttr(first, second map[string]*commonpb.AnyValue, key string) string {
	if v := first[key].GetStringValue(); v != "" {
		return v
	}
	return second[key].GetStringValue()
}

func attrFloat64(attrs map[string]*commonpb.AnyValue, key string) float64 {
	v, ok := attrs[key]
	if !ok || v == nil {
		return 0
	}

	switch x := v.Value.(type) {
	case *commonpb.AnyValue_DoubleValue:
		return x.DoubleValue
	case *commonpb.AnyValue_IntValue:
		return float64(x.IntValue)
	default:
		return 0
	}
}

func attrsForStorage(attrs map[string]*commonpb.AnyValue) map[string]any {
	out := make(map[string]any, len(attrs))
	for key, value := range attrs {
		out[key] = anyValue(value)
	}
	return out
}

func unixNano(v uint64) time.Time {
	if v > uint64(1<<63-1) {
		return time.Unix(0, 0).UTC()
	}
	return time.Unix(0, int64(v)).UTC()
}

func spanKind(kind tracepb.Span_SpanKind) string {
	switch kind {
	case tracepb.Span_SPAN_KIND_INTERNAL:
		return "INTERNAL"
	case tracepb.Span_SPAN_KIND_SERVER:
		return "SERVER"
	case tracepb.Span_SPAN_KIND_CLIENT:
		return "CLIENT"
	case tracepb.Span_SPAN_KIND_PRODUCER:
		return "PRODUCER"
	case tracepb.Span_SPAN_KIND_CONSUMER:
		return "CONSUMER"
	default:
		return ""
	}
}

func statusCode(status *tracepb.Status) string {
	switch status.GetCode() {
	case tracepb.Status_STATUS_CODE_OK:
		return statusOK
	case tracepb.Status_STATUS_CODE_ERROR:
		return statusError
	default:
		return ""
	}
}

func hasPayloadValue(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	trimmed := strings.TrimSpace(string(raw))
	return trimmed != "" && trimmed != null
}
