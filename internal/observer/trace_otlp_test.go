package observer

import (
	"testing"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestNormalizeTraceRequestExtractsGenAIPayloads(t *testing.T) {
	t.Parallel()

	const agentName = "agent-sample"
	const sessionID = "ses_123"
	req := &tracev1.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{
					stringKV(attrClawArmorAgentName, agentName),
				},
			},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{newTestOTLPSpan([]*commonpb.KeyValue{
					stringKV(attrSessionID, sessionID),
					stringKV(attrSpanKind, "LLM"),
					stringKV(attrLLMInputMessages, `[{"role":"user","content":"hi"}]`),
					stringKV(attrLLMOutputMessages, `[{"role":"assistant","content":"hello"}]`),
					stringKV(attrLLMModelName, "gpt-5.4-mini"),
					intKV(attrLLMTokenPrompt, 3),
					intKV(attrLLMTokenCompletion, 4),
					intKV(attrLLMTokenCacheWrite, 1),
					doubleKV(attrLLMCostTotal, 0.12),
					stringKV(attrLLMFinishReason, "stop"),
				})},
			}},
		}},
	}

	events, rejected := normalizeTraceRequest(req)
	if rejected != 0 {
		t.Fatalf("rejected = %d, want 0", rejected)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	ev := events[0]
	if ev.agentName != agentName {
		t.Fatalf("agentName = %s, want %s", ev.agentName, agentName)
	}
	if ev.sessionID != sessionID {
		t.Fatalf("sessionID = %s, want %s", ev.sessionID, sessionID)
	}
	if ev.spanClass != "llm" {
		t.Fatalf("spanClass = %q, want llm", ev.spanClass)
	}
	if ev.operationName != "chat" {
		t.Fatalf("operationName = %q, want chat", ev.operationName)
	}
	if ev.inputTokens != 3 || ev.outputTokens != 4 {
		t.Fatalf("tokens = %d/%d, want 3/4", ev.inputTokens, ev.outputTokens)
	}
	if ev.cachedWriteTokens != 1 {
		t.Fatalf("cachedWriteTokens = %d, want 1", ev.cachedWriteTokens)
	}
	if ev.costUSD != 0.12 {
		t.Fatalf("costUSD = %v, want 0.12", ev.costUSD)
	}
	if ev.parentSpanID == nil {
		t.Fatalf("parentSpanID is nil, want empty byte slice for root spans")
	}
	if len(ev.parentSpanID) != 0 {
		t.Fatalf("len(parentSpanID) = %d, want 0", len(ev.parentSpanID))
	}
	if string(ev.payload.inputMessages) != `[{"role":"user","content":"hi"}]` {
		t.Fatalf("input payload = %s", ev.payload.inputMessages)
	}
	if string(ev.payload.outputMessages) != `[{"role":"assistant","content":"hello"}]` {
		t.Fatalf("output payload = %s", ev.payload.outputMessages)
	}
	if string(ev.payload.toolResult) != null {
		t.Fatalf("toolResult = %s, want null for llm spans", ev.payload.toolResult)
	}
	if len(ev.resourceAttributes) == 0 || string(ev.resourceAttributes) == "{}" {
		t.Fatalf("resourceAttributes = %s, want non-empty object", ev.resourceAttributes)
	}
	if len(ev.spanAttributes) == 0 || string(ev.spanAttributes) == "{}" {
		t.Fatalf("spanAttributes = %s, want non-empty object", ev.spanAttributes)
	}
}

func TestNormalizeTraceRequestExtractsToolPayloadsOnlyForToolSpans(t *testing.T) {
	t.Parallel()

	const agentName = "agent-sample"
	const sessionID = "ses_123"
	req := &tracev1.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{
					stringKV(attrClawArmorAgentName, agentName),
				},
			},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{newTestOTLPSpan([]*commonpb.KeyValue{
					stringKV(attrSessionID, sessionID),
					stringKV(attrSpanKind, "TOOL"),
					stringKV(attrToolName, "bash"),
					stringKV(attrToolParameters, `{"command":"pwd"}`),
					stringKV(attrOutputValue, "done"),
				})},
			}},
		}},
	}

	events, rejected := normalizeTraceRequest(req)
	if rejected != 0 {
		t.Fatalf("rejected = %d, want 0", rejected)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	ev := events[0]
	if ev.spanClass != spanClassTool {
		t.Fatalf("spanClass = %q, want %s", ev.spanClass, spanClassTool)
	}
	if string(ev.payload.toolArguments) != `{"command":"pwd"}` {
		t.Fatalf("toolArguments = %s", ev.payload.toolArguments)
	}
	if string(ev.payload.toolResult) != `"done"` {
		t.Fatalf("toolResult = %s, want %q", ev.payload.toolResult, `"done"`)
	}
}

func TestNormalizeTraceRequestDoesNotExtractLLMPayloadsForSessionSpans(t *testing.T) {
	t.Parallel()

	const agentName = "agent-sample"
	const sessionID = "ses_123"
	req := &tracev1.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{
					stringKV(attrClawArmorAgentName, agentName),
				},
			},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{newTestOTLPSpan([]*commonpb.KeyValue{
					stringKV(attrSessionID, sessionID),
					stringKV(attrSpanKind, "AGENT"),
					stringKV(attrLLMInputMessages, `[{"role":"user","content":"hi"}]`),
					stringKV(attrLLMOutputMessages, `[{"role":"assistant","content":"hello"}]`),
				})},
			}},
		}},
	}

	events, rejected := normalizeTraceRequest(req)
	if rejected != 0 {
		t.Fatalf("rejected = %d, want 0", rejected)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	ev := events[0]
	if ev.spanClass != spanClassSession {
		t.Fatalf("spanClass = %q, want %s", ev.spanClass, spanClassSession)
	}
	if string(ev.payload.inputMessages) != null {
		t.Fatalf("inputMessages = %s, want null", ev.payload.inputMessages)
	}
	if string(ev.payload.outputMessages) != null {
		t.Fatalf("outputMessages = %s, want null", ev.payload.outputMessages)
	}
}

func newTestOTLPSpan(attrs []*commonpb.KeyValue) *tracepb.Span {
	return &tracepb.Span{
		TraceId:           []byte("1234567890123456"),
		SpanId:            []byte("12345678"),
		Name:              "chat gpt-4",
		Kind:              tracepb.Span_SPAN_KIND_INTERNAL,
		StartTimeUnixNano: 100,
		EndTimeUnixNano:   200,
		Attributes:        attrs,
	}
}

func stringKV(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{
		Key: key,
		Value: &commonpb.AnyValue{
			Value: &commonpb.AnyValue_StringValue{StringValue: value},
		},
	}
}

func intKV(key string, value int64) *commonpb.KeyValue {
	return &commonpb.KeyValue{
		Key: key,
		Value: &commonpb.AnyValue{
			Value: &commonpb.AnyValue_IntValue{IntValue: value},
		},
	}
}

func doubleKV(key string, value float64) *commonpb.KeyValue {
	return &commonpb.KeyValue{
		Key: key,
		Value: &commonpb.AnyValue{
			Value: &commonpb.AnyValue_DoubleValue{DoubleValue: value},
		},
	}
}
