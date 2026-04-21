package observer

import (
	"testing"

	"github.com/google/uuid"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestNormalizeTraceRequestExtractsGenAIPayloads(t *testing.T) {
	t.Parallel()

	sessionID := uuid.MustParse("51047bae-702a-4115-bcde-95fff10593bb")
	req := &tracev1.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{
					stringKV(attrClawArmorSessionID, sessionID.String()),
				},
			},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{newTestOTLPSpan([]*commonpb.KeyValue{
					stringKV(attrGenAIOperation, "chat"),
					stringKV(attrGenAIInputMessages, `[{"role":"user","content":"hi"}]`),
					stringKV(attrGenAIOutputMessages, `[{"role":"assistant","content":"hello"}]`),
					stringKV(attrLLMRequest, `{"messages":[{"role":"user","content":"hi"}],"generation_config":{"stream":true,"temperature":0.2}}`),
					stringKV(attrLLMResponse, `{"id":"chatcmpl-1","model":"gpt-5.4-mini","choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":3,"completion_tokens":4},"done":true}`),
					intKV(attrGenAIUsageInputTokens, 3),
					intKV(attrGenAIUsageOutputTokens, 4),
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
	if ev.sessionID != sessionID {
		t.Fatalf("sessionID = %s, want %s", ev.sessionID, sessionID)
	}
	if ev.operationName != "chat" {
		t.Fatalf("operationName = %q, want chat", ev.operationName)
	}
	if ev.inputTokens != 3 || ev.outputTokens != 4 {
		t.Fatalf("tokens = %d/%d, want 3/4", ev.inputTokens, ev.outputTokens)
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
	wantMetadata := `{"done":true,"generation_config":{"stream":true,"temperature":0.2},"id":"chatcmpl-1","input_tokens":3,"model":"gpt-5.4-mini","output_tokens":4,"usage":{"completion_tokens":4,"prompt_tokens":3}}`
	if string(ev.payload.metadata) != wantMetadata {
		t.Fatalf("metadata = %s, want %s", ev.payload.metadata, wantMetadata)
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
