package observer

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync/atomic"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
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

	res   *resolver
	out   chan<- event
	stats *stats
}

type mcpToolResult struct {
	IsError bool `json:"isError"`
}

func runOTLPTraceReceiver(ctx context.Context, cfg Config, res *resolver, out chan<- event, s *stats) error {
	lis, err := net.Listen("tcp", cfg.OTLPTraceGRPCAddr)
	if err != nil {
		return fmt.Errorf("listen otlp trace grpc %s: %w", cfg.OTLPTraceGRPCAddr, err)
	}

	srv := grpc.NewServer()
	tracev1.RegisterTraceServiceServer(
		srv,
		&traceReceiver{
			res:   res,
			out:   out,
			stats: s,
		},
	)

	errCh := make(chan error, 1)
	go func() {
		slog.InfoContext(ctx, "starting OTLP trace receiver", slog.String("addr", cfg.OTLPTraceGRPCAddr))
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		srv.GracefulStop()
		err = <-errCh
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve otlp trace grpc: %w", err)
		}
		return nil
	case err = <-errCh:
		if err != nil && err != grpc.ErrServerStopped {
			return fmt.Errorf("serve otlp trace grpc: %w", err)
		}
		return nil
	}
}

func (r *traceReceiver) Export(ctx context.Context, req *tracev1.ExportTraceServiceRequest) (*tracev1.ExportTraceServiceResponse, error) {
	events, rejected := traceEventsFromOTLPRequest(ctx, r.res, req)
	for _, ev := range events {
		if err := sendEvent(ctx, r.out, event{trace: &ev}); err != nil {
			return nil, err
		}
	}
	if rejected > 0 {
		atomic.AddUint64(&r.stats.filtered, uint64(rejected))
	}
	atomic.AddUint64(&r.stats.received, uint64(len(events)+rejected))
	return &tracev1.ExportTraceServiceResponse{}, nil
}

func traceEventsFromOTLPRequest(ctx context.Context, res *resolver, req *tracev1.ExportTraceServiceRequest) ([]traceSpanEvent, int) {
	if req == nil {
		return nil, 0
	}

	events := make([]traceSpanEvent, 0)
	rejected := 0
	for _, rs := range req.GetResourceSpans() {
		resourceAttrs := attrsMap(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				ev, err := traceEventFromOTLPSpan(ctx, res, sp, resourceAttrs)
				if err != nil {
					rejected++
					continue
				}
				events = append(events, ev)
			}
		}
	}
	return events, rejected
}

func traceEventFromOTLPSpan(_ context.Context, _ *resolver, sp *tracepb.Span, resourceAttrs map[string]*commonpb.AnyValue) (traceSpanEvent, error) {
	if sp == nil || len(sp.GetTraceId()) != 16 || len(sp.GetSpanId()) != 8 {
		return traceSpanEvent{}, errTraceAgentNameMissing
	}

	spanAttrs := attrsMap(sp.GetAttributes())

	agentName, err := requiredStringAttr(spanAttrs, resourceAttrs, attrAgentZAgentName, errTraceAgentNameMissing)
	if err != nil {
		return traceSpanEvent{}, err
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
	var statusMessage string
	if sp.GetStatus() != nil {
		statusMessage = sp.GetStatus().GetMessage()
	}
	errorMessage := cmp.Or(
		firstStringAttr(spanAttrs, resourceAttrs, attrErrorMessage),
		statusMessage,
		firstStringAttr(spanAttrs, resourceAttrs, attrError),
	)

	model := cmp.Or(
		attrString(spanAttrs, attrLLMModelName),
		attrString(spanAttrs, attrGenAIResponseModel),
		attrString(spanAttrs, attrGenAIRequestModel),
	)
	toolName := cmp.Or(
		attrString(spanAttrs, attrToolName),
		attrString(spanAttrs, attrGenAIToolName),
		attrString(spanAttrs, attrMCPToolName),
	)

	payload, strippedAttrs := extractSpanPayload(spanClass, spanAttrs)
	resourceJSON := jsonObject(resourceAttrsForStorage(resourceAttrs))
	spanJSON := jsonObject(strippedAttrs)
	var mcpToolCall *mcpToolCallEvent
	if spanClass == spanClassTool && toolName != "" {
		connectionName := cmp.Or(
			attrString(spanAttrs, attrMCPConnectionName),
			attrString(spanAttrs, attrMCPDefaultTarget),
		)
		mcpToolName := cmp.Or(
			attrString(spanAttrs, attrMCPToolName),
			attrString(spanAttrs, attrGenAIToolName),
		)
		if connectionName != "" && mcpToolName != "" {
			failed := status == statusError || hasPayloadValue(payload.toolError)
			result := mcpToolResult{}
			if !failed && json.Unmarshal(payload.toolResult, &result) == nil {
				failed = result.IsError
			}
			mcpToolCall = &mcpToolCallEvent{
				agentName:         agentName,
				traceID:           cloneBytes(sp.GetTraceId()),
				spanID:            cloneBytes(sp.GetSpanId()),
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
		traceID:         cloneBytes(sp.GetTraceId()),
		spanID:          cloneBytes(sp.GetSpanId()),
		parentSpanID:    cloneBytes(sp.GetParentSpanId()),
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
			attrInt64(spanAttrs, attrLLMTokenPrompt),
			attrInt64(spanAttrs, attrGenAIInputTokens),
		),
		outputTokens: cmp.Or(
			attrInt64(spanAttrs, attrLLMTokenCompletion),
			attrInt64(spanAttrs, attrGenAIOutputTokens),
		),
		cachedInputTokens: cmp.Or(
			attrInt64(spanAttrs, attrLLMTokenCacheRead),
			attrInt64(spanAttrs, attrGenAICacheRead),
		),
		cachedWriteTokens: cmp.Or(
			attrInt64(spanAttrs, attrLLMTokenCacheWrite),
			attrInt64(spanAttrs, attrGenAICacheWrite),
		),
		costUSD:            attrFloat64(spanAttrs, attrLLMCostTotal),
		llmFinishReason:    attrString(spanAttrs, attrLLMFinishReason),
		resourceAttributes: resourceJSON,
		spanAttributes:     spanJSON,
		payload:            payload,
		mcpToolCall:        mcpToolCall,
	}, nil
}

func resourceAttrsForStorage(attrs map[string]*commonpb.AnyValue) map[string]any {
	out := attrsForStorage(attrs)
	delete(out, "os.type")
	delete(out, "host.arch")
	return out
}

func extractSpanPayload(spanClass string, attrs map[string]*commonpb.AnyValue) (traceSpanPayload, map[string]any) {
	out := attrsForStorage(attrs)
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
	switch strings.ToUpper(attrString(attrs, attrSpanKind)) {
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
	case attrString(attrs, attrMCPMethodName) == "tools/call":
		return spanClassTool, operationExecuteTool
	case attrString(attrs, attrMCPToolName) != "":
		return spanClassTool, operationExecuteTool
	case attrString(attrs, attrGenAIToolName) != "":
		return spanClassTool, operationExecuteTool
	default:
		return "", ""
	}
}

func requiredStringAttr(first, second map[string]*commonpb.AnyValue, key string, err error) (string, error) {
	v := strings.TrimSpace(firstStringAttr(first, second, key))
	if v == "" {
		return "", err
	}
	return v, nil
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
	if raw, ok := v.([]byte); ok && json.Valid(raw) {
		return raw
	}
	if s, ok := v.(string); ok && json.Valid([]byte(s)) {
		return []byte(s)
	}
	return mustJSON(v)
}

func jsonObject(v map[string]any) []byte {
	if len(v) == 0 {
		return []byte("{}")
	}
	return mustJSON(v)
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		return []byte(null)
	}
	return data
}

func firstStringAttr(first, second map[string]*commonpb.AnyValue, key string) string {
	if v := attrString(first, key); v != "" {
		return v
	}
	return attrString(second, key)
}

func attrString(attrs map[string]*commonpb.AnyValue, key string) string {
	v, ok := attrs[key]
	if !ok || v == nil {
		return ""
	}
	x, ok := v.Value.(*commonpb.AnyValue_StringValue)
	if !ok {
		return ""
	}
	return x.StringValue
}

func attrInt64(attrs map[string]*commonpb.AnyValue, key string) int64 {
	v, ok := attrs[key]
	if !ok || v == nil {
		return 0
	}
	x, ok := v.Value.(*commonpb.AnyValue_IntValue)
	if !ok {
		return 0
	}
	return x.IntValue
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
	if status == nil {
		return ""
	}
	switch status.GetCode() {
	case tracepb.Status_STATUS_CODE_OK:
		return statusOK
	case tracepb.Status_STATUS_CODE_ERROR:
		return statusError
	default:
		return ""
	}
}

func cloneBytes(in []byte) []byte {
	if len(in) == 0 {
		return []byte{}
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func hasPayloadValue(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	trimmed := strings.TrimSpace(string(raw))
	return trimmed != "" && trimmed != null
}
