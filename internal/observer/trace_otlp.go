package observer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
)

const (
	attrClawArmorAgentName = "clawarmor.agent_name"
	attrClawArmorRunID     = "clawarmor.run_id"
	attrClawArmorRequestID = "clawarmor.request_id"

	attrK8sNamespace = "k8s.namespace.name"
	attrK8sPodName   = "k8s.pod.name"

	attrGenAIOperation              = "gen_ai.operation.name"
	attrGenAIConversation           = "gen_ai.conversation.id"
	attrGenAIRequestModel           = "gen_ai.request.model"
	attrGenAIResponseModel          = "gen_ai.response.model"
	attrGenAIInputMessages          = "gen_ai.input.messages"
	attrGenAIOutputMessages         = "gen_ai.output.messages"
	attrGenAIUsageInputTokens       = "gen_ai.usage.input_tokens"
	attrGenAIUsageOutputTokens      = "gen_ai.usage.output_tokens"
	attrGenAIUsageInputTokensCached = "gen_ai.usage.input_tokens.cached"
	attrGenAIToolName               = "gen_ai.tool.name"
	attrGenAIToolCallArguments      = "gen_ai.tool.call.arguments"
	attrGenAIToolCallResult         = "gen_ai.tool.call.result"
	attrLLMRequest                  = "trpc.go.agent.llm_request"
	attrLLMResponse                 = "trpc.go.agent.llm_response"
	attrTimeToFirstToken            = "trpc_agent_go.client.time_to_first_token"
	attrErrorType                   = "error.type"
	attrErrorMessage                = "error.message"
)

var errTraceAgentNameMissing = errors.New("clawarmor.agent_name missing")

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
		r.stats.addFiltered(uint64(rejected))
	}
	r.stats.addReceived(uint64(len(events) + rejected))
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
	agentName, err := requiredAgentName(spanAttrs, resourceAttrs)
	if err != nil {
		return traceSpanEvent{}, err
	}

	start := unixNano(sp.GetStartTimeUnixNano())
	end := unixNano(sp.GetEndTimeUnixNano())
	duration := max(end.Sub(start).Nanoseconds(), 0)

	statusCode := statusCode(sp.GetStatus())
	errorMessage := stringAttr(spanAttrs, attrErrorMessage)
	if errorMessage == "" && sp.GetStatus() != nil {
		errorMessage = sp.GetStatus().GetMessage()
	}

	payload := traceSpanPayload{
		inputMessages:  jsonPayload(spanAttrs[attrGenAIInputMessages]),
		outputMessages: jsonPayload(spanAttrs[attrGenAIOutputMessages]),
		toolArguments:  jsonPayload(spanAttrs[attrGenAIToolCallArguments]),
		toolResult:     jsonPayload(spanAttrs[attrGenAIToolCallResult]),
		metadata:       traceMetadata(spanAttrs),
	}

	modelName := stringAttr(spanAttrs, attrGenAIRequestModel)
	if modelName == "" {
		modelName = stringAttr(spanAttrs, attrGenAIResponseModel)
	}

	return traceSpanEvent{
		agentName:          agentName,
		traceID:            cloneBytes(sp.GetTraceId()),
		spanID:             cloneBytes(sp.GetSpanId()),
		parentSpanID:       cloneBytes(sp.GetParentSpanId()),
		startTime:          start,
		endTime:            end,
		durationNS:         duration,
		name:               sp.GetName(),
		operationName:      stringAttr(spanAttrs, attrGenAIOperation),
		kind:               spanKind(sp.GetKind()),
		statusCode:         statusCode,
		errorType:          stringAttr(spanAttrs, attrErrorType),
		errorMessage:       errorMessage,
		conversationID:     stringAttr(spanAttrs, attrGenAIConversation),
		runID:              firstStringAttr(spanAttrs, resourceAttrs, attrClawArmorRunID),
		requestID:          firstStringAttr(spanAttrs, resourceAttrs, attrClawArmorRequestID),
		model:              modelName,
		toolName:           stringAttr(spanAttrs, attrGenAIToolName),
		inputTokens:        intAttr(spanAttrs, attrGenAIUsageInputTokens),
		outputTokens:       intAttr(spanAttrs, attrGenAIUsageOutputTokens),
		cachedInputTokens:  intAttr(spanAttrs, attrGenAIUsageInputTokensCached),
		timeToFirstTokenMS: floatAttr(spanAttrs, attrTimeToFirstToken) * 1000,
		podNamespace:       firstStringAttr(spanAttrs, resourceAttrs, attrK8sNamespace),
		podName:            firstStringAttr(spanAttrs, resourceAttrs, attrK8sPodName),
		payload:            payload,
	}, nil
}

func requiredAgentName(spanAttrs, resourceAttrs map[string]any) (string, error) {
	raw := strings.TrimSpace(firstStringAttr(spanAttrs, resourceAttrs, attrClawArmorAgentName))
	if raw == "" {
		return "", errTraceAgentNameMissing
	}
	return raw, nil
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

func traceMetadata(attrs map[string]any) []byte {
	meta := map[string]any{}
	addLLMRequestMetadata(meta, attrs[attrLLMRequest])
	addLLMResponseMetadata(meta, attrs[attrLLMResponse])
	addAttr(meta, "input_tokens", attrs[attrGenAIUsageInputTokens])
	addAttr(meta, "output_tokens", attrs[attrGenAIUsageOutputTokens])
	addAttr(meta, "cached_input_tokens", attrs[attrGenAIUsageInputTokensCached])
	addAttr(meta, "time_to_first_token", attrs[attrTimeToFirstToken])
	return jsonObject(meta)
}

func addLLMRequestMetadata(meta map[string]any, raw any) {
	req, ok := jsonMap(raw)
	if !ok {
		return
	}
	if cfg, ok := req["generation_config"]; ok {
		meta["generation_config"] = cfg
	}
}

func addLLMResponseMetadata(meta map[string]any, raw any) {
	resp, ok := jsonMap(raw)
	if !ok {
		return
	}
	keys := []string{
		"id",
		"model",
		"object",
		"created",
		"timestamp",
		"done",
		"is_partial",
		"usage",
	}
	for _, key := range keys {
		addAttr(meta, key, resp[key])
	}
}

func jsonMap(raw any) (map[string]any, bool) {
	switch v := raw.(type) {
	case map[string]any:
		return v, true
	case string:
		var out map[string]any
		if err := json.Unmarshal([]byte(v), &out); err != nil {
			return nil, false
		}
		return out, true
	default:
		return nil, false
	}
}

func addAttr(meta map[string]any, key string, value any) {
	if value == nil {
		return
	}
	meta[key] = value
}

func jsonPayload(v any) []byte {
	if v == nil {
		return []byte("null")
	}
	if s, ok := v.(string); ok {
		if json.Valid([]byte(s)) {
			return []byte(s)
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
		return []byte("null")
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
	case string:
		n, _ := strconv.ParseFloat(v, 64)
		return n
	default:
		return 0
	}
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
