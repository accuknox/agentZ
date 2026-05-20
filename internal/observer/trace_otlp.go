package observer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
)

const (
	attrClawArmorAgentName = "clawarmor.agent_name"
	attrSessionID          = "session.id"
	attrSpanKind           = "openinference.span.kind"

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

	attrToolName       = "tool.name"
	attrToolParameters = "tool.parameters"
	attrToolError      = "tool.error"

	attrErrorType    = "error.type"
	attrErrorMessage = "error.message"

	null = "null"

	spanClassSession = "session"
	spanClassLLM     = "llm"
	spanClassTool    = "tool"

	operationSession     = "session"
	operationChat        = "chat"
	operationExecuteTool = "execute_tool"
)

var (
	errTraceAgentNameMissing = errors.New("clawarmor.agent_name missing")
	errTraceSessionIDMissing = errors.New("session.id missing")
)

type traceReceiver struct {
	tracev1.UnimplementedTraceServiceServer

	out   chan<- event
	stats *stats
}

func runOTLPTraceReceiver(ctx context.Context, cfg Config, out chan<- event, s *stats) error {
	lis, err := net.Listen("tcp", cfg.OTLPTraceGRPCAddr)
	if err != nil {
		return fmt.Errorf("listen otlp trace grpc %s: %w", cfg.OTLPTraceGRPCAddr, err)
	}

	srv := grpc.NewServer()
	tracev1.RegisterTraceServiceServer(srv, &traceReceiver{
		out:   out,
		stats: s,
	})

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
	events, rejected := normalizeTraceRequest(req)
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

func normalizeTraceRequest(req *tracev1.ExportTraceServiceRequest) ([]traceSpanEvent, int) {
	if req == nil {
		return nil, 0
	}

	events := make([]traceSpanEvent, 0)
	rejected := 0
	for _, rs := range req.GetResourceSpans() {
		resourceAttrs := attrsMap(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				ev, err := normalizeTraceSpan(sp, resourceAttrs)
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

func normalizeTraceSpan(sp *tracepb.Span, resourceAttrs map[string]any) (traceSpanEvent, error) {
	if sp == nil || len(sp.GetTraceId()) != 16 || len(sp.GetSpanId()) != 8 {
		return traceSpanEvent{}, errTraceAgentNameMissing
	}

	spanAttrs := attrsMap(sp.GetAttributes())

	agentName, err := requiredStringAttr(spanAttrs, resourceAttrs, attrClawArmorAgentName, errTraceAgentNameMissing)
	if err != nil {
		return traceSpanEvent{}, err
	}

	sessionID, err := requiredStringAttr(spanAttrs, resourceAttrs, attrSessionID, errTraceSessionIDMissing)
	if err != nil {
		return traceSpanEvent{}, err
	}

	start := unixNano(sp.GetStartTimeUnixNano())
	end := unixNano(sp.GetEndTimeUnixNano())
	durationNS := max(end.Sub(start).Nanoseconds(), 0)
	durationMS := float64(durationNS) / float64(time.Millisecond)

	spanClass, operationName := classifySpan(sp.GetName(), spanAttrs)
	status := statusCode(sp.GetStatus())
	errorMessage := firstStringAttr(spanAttrs, resourceAttrs, attrErrorMessage)
	if errorMessage == "" && sp.GetStatus() != nil {
		errorMessage = sp.GetStatus().GetMessage()
	}

	model := firstNonEmpty(
		stringAttr(spanAttrs, attrLLMModelName),
		stringAttr(spanAttrs, "gen_ai.response.model"),
		stringAttr(spanAttrs, "gen_ai.request.model"),
	)

	toolName := firstNonEmpty(
		stringAttr(spanAttrs, attrToolName),
		stringAttr(spanAttrs, "gen_ai.tool.name"),
	)

	payload, strippedAttrs := extractSpanPayload(spanClass, spanAttrs)
	resourceJSON := jsonObject(resourceAttrsForStorage(resourceAttrs))
	spanJSON := jsonObject(strippedAttrs)

	return traceSpanEvent{
		agentName:          agentName,
		sessionID:          sessionID,
		traceID:            cloneBytes(sp.GetTraceId()),
		spanID:             cloneBytes(sp.GetSpanId()),
		parentSpanID:       cloneBytes(sp.GetParentSpanId()),
		startTime:          start,
		endTime:            end,
		durationNS:         durationNS,
		durationMS:         durationMS,
		name:               sp.GetName(),
		spanClass:          spanClass,
		operationName:      operationName,
		kind:               spanKind(sp.GetKind()),
		statusCode:         status,
		errorType:          firstStringAttr(spanAttrs, resourceAttrs, attrErrorType),
		errorMessage:       errorMessage,
		model:              model,
		toolName:           toolName,
		inputTokens:        intAttr(spanAttrs, attrLLMTokenPrompt),
		outputTokens:       intAttr(spanAttrs, attrLLMTokenCompletion),
		cachedInputTokens:  intAttr(spanAttrs, attrLLMTokenCacheRead),
		cachedWriteTokens:  intAttr(spanAttrs, attrLLMTokenCacheWrite),
		costUSD:            floatAttr(spanAttrs, attrLLMCostTotal),
		llmFinishReason:    stringAttr(spanAttrs, attrLLMFinishReason),
		resourceAttributes: resourceJSON,
		spanAttributes:     spanJSON,
		payload:            payload,
	}, nil
}

func resourceAttrsForStorage(attrs map[string]any) map[string]any {
	out := cloneMap(attrs)
	delete(out, "os.type")
	delete(out, "host.arch")
	return out
}

func extractSpanPayload(spanClass string, attrs map[string]any) (traceSpanPayload, map[string]any) {
	out := cloneMap(attrs)
	inputMessages := []byte(null)
	outputMessages := []byte(null)
	if spanClass == spanClassLLM {
		inputMessages = extractJSONPayload(out, attrLLMInputMessages)
		outputMessages = extractJSONPayload(out, attrLLMOutputMessages)
	}

	toolArguments := []byte(null)
	toolResult := []byte(null)
	if spanClass == spanClassTool {
		toolArguments = extractJSONPayload(out, attrToolParameters)
		if string(toolArguments) == null {
			toolArguments = extractJSONPayload(out, "gen_ai.tool.call.arguments")
		}

		toolResult = extractJSONPayload(out, attrOutputValue)
		if string(toolResult) == null {
			toolResult = extractJSONPayload(out, "gen_ai.tool.call.result")
		}
		if string(toolResult) == null {
			toolResult = extractJSONPayload(out, attrToolError)
		}

		delete(out, attrInputValue)
		delete(out, attrInputMimeType)
		delete(out, attrOutputMimeType)
	}

	return traceSpanPayload{
		inputMessages:  inputMessages,
		outputMessages: outputMessages,
		toolArguments:  toolArguments,
		toolResult:     toolResult,
	}, out
}

func extractJSONPayload(attrs map[string]any, key string) []byte {
	v, ok := attrs[key]
	if !ok {
		return []byte(null)
	}
	delete(attrs, key)
	return jsonPayload(v)
}

func classifySpan(name string, attrs map[string]any) (string, string) {
	switch strings.ToUpper(stringAttr(attrs, attrSpanKind)) {
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
	default:
		return "", ""
	}
}

func requiredStringAttr(first, second map[string]any, key string, err error) (string, error) {
	v := strings.TrimSpace(firstStringAttr(first, second, key))
	if v == "" {
		return "", err
	}
	return v, nil
}

func attrsMap(attrs []*commonpb.KeyValue) map[string]any {
	out := make(map[string]any, len(attrs))
	for _, attr := range attrs {
		if attr == nil || attr.Key == "" {
			continue
		}
		out[attr.Key] = anyValue(attr.Value)
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
		return attrsMap(x.KvlistValue.GetValues())
	default:
		return nil
	}
}

func jsonPayload(v any) []byte {
	if v == nil {
		return []byte(null)
	}
	switch x := v.(type) {
	case string:
		if json.Valid([]byte(x)) {
			return []byte(x)
		}
	case []byte:
		if json.Valid(x) {
			return x
		}
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

func firstStringAttr(first, second map[string]any, key string) string {
	if v := stringAttr(first, key); v != "" {
		return v
	}
	return stringAttr(second, key)
}

func stringAttr(attrs map[string]any, key string) string {
	switch v := attrs[key].(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return ""
	}
}

func intAttr(attrs map[string]any, key string) int64 {
	switch v := attrs[key].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	default:
		return 0
	}
}

func floatAttr(attrs map[string]any, key string) float64 {
	switch v := attrs[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case string:
		n, _ := strconv.ParseFloat(v, 64)
		return n
	default:
		return 0
	}
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	maps.Copy(out, in)
	return out
}

func firstNonEmpty(items ...string) string {
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item != "" {
			return item
		}
	}
	return ""
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
		return "OK"
	case tracepb.Status_STATUS_CODE_ERROR:
		return "ERROR"
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
