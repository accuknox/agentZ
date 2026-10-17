package observer

import (
	"bytes"
	"strings"
	"testing"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func appSpanFixture(payloadSize int) *tracepb.Span {
	attributes := map[string]string{
		"agentz.organization_id": "telemetry-test-org", "agentz.workspace_id": "telemetry-test-workspace",
		"agentz.client_id": "telemetry-test-client", "agentz.app_name": "Telemetry test",
		"agentz.grant_id": "telemetry-test-grant", "agentz.user_id": "telemetry-test-user",
		"agentz.resource_kind": "inference", "agentz.resource_namespace": "telemetry-test-namespace",
		"agentz.resource_name": "provider", "agentz.resource_uid": "provider-uid", "agentz.target_id": "model",
		attrGenAIResponseModel: "fixture-model", "agw.ai.usage.cost.total": "0.00125",
		attrLLMInputMessages:  `{"messages":[{"role":"user","content":"` + strings.Repeat("x", payloadSize) + `"}]}`,
		attrLLMOutputMessages: `{"completion":["answer"],"tool_calls":[{"id":"call-1","name":"lookup","arguments":"{\"n\":9007199254740993}"}]}`,
	}
	span := &tracepb.Span{
		TraceId: bytes.Repeat([]byte{1}, 16), SpanId: bytes.Repeat([]byte{2}, 8),
		Name: "inference", Kind: tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: uint64(time.Second),
	}
	span.EndTimeUnixNano = span.StartTimeUnixNano + uint64(time.Millisecond)
	for name, value := range attributes {
		span.Attributes = append(span.Attributes, &commonpb.KeyValue{
			Key: name, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
		})
	}
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key: attrGenAIInputTokens, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 0}},
	})
	return span
}

func TestAppOperationContentAndUsage(t *testing.T) {
	span := appSpanFixture(1 << 20)
	op, err := appOperationFromOTLPSpan(span)
	if err != nil {
		t.Fatal(err)
	}
	if !op.InputTokens.Valid || op.InputTokens.Int64 != 0 || op.OutputTokens.Valid {
		t.Fatalf("known zero and unknown usage lost: input=%+v output=%+v", op.InputTokens, op.OutputTokens)
	}
	if !op.CostUsd.Valid || op.CostUsd.Float64 != 0.00125 || op.DurationNs != int64(time.Millisecond) {
		t.Fatalf("cost or duration lost: %+v", op)
	}
	if len(op.InputMessages) < 1<<20 || !bytes.Contains(op.OutputMessages, []byte("9007199254740993")) {
		t.Fatal("full input or tool call output lost")
	}
	span.Kind = tracepb.Span_SPAN_KIND_CLIENT
	if _, err := appOperationFromOTLPSpan(span); err == nil {
		t.Fatal("child span accepted as a second app operation")
	}
}

func TestAppMCPFailureAndAttribution(t *testing.T) {
	span := appSpanFixture(0)
	for _, attr := range span.Attributes {
		if attr.Key == "agentz.resource_kind" {
			attr.Value = &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "mcp"}}
		}
	}
	attributes := map[string]string{
		attrMCPMethodName: "tools/call", attrGenAIToolName: "lookup",
		attrToolParameters: `{"n":9007199254740993}`, attrOutputValue: `{"isError":true,"structuredContent":{"reason":"denied"}}`,
		attrToolError: `{"code":-32001,"message":"denied","data":{"n":9007199254740993}}`,
	}
	for name, value := range attributes {
		span.Attributes = append(span.Attributes, &commonpb.KeyValue{
			Key: name, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
		})
	}
	op, err := appOperationFromOTLPSpan(span)
	if err != nil {
		t.Fatal(err)
	}
	if op.StatusCode != statusError || !bytes.Contains(op.ToolError, []byte("9007199254740993")) {
		t.Fatal("MCP failure or error data lost")
	}
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key: "agentz.workspace_id", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{}},
	})
	if _, err := appOperationFromOTLPSpan(span); err == nil {
		t.Fatal("unattributed app operation accepted")
	}
}

func BenchmarkAppOperationCapture(b *testing.B) {
	for name, size := range map[string]int{"small": 1024, "normal": 90_000, "large": 1 << 20} {
		b.Run(name, func(b *testing.B) {
			span := appSpanFixture(size)
			b.ReportAllocs()
			b.SetBytes(int64(size))
			for b.Loop() {
				if _, err := appOperationFromOTLPSpan(span); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestAppNativeIdentityRequiresRegistration(t *testing.T) {
	for _, kind := range []string{"", "ordinary-app", "claude", "codex"} {
		t.Run(kind, func(t *testing.T) {
			span := appSpanFixture(0)
			labels := map[string]string{
				"agentz.agent_kind":   kind,
				attrSessionID:         "native-conversation",
				"agentz.turn_id":      "native-turn",
				"gen_ai.tool.call.id": "native-call",
				attrMCPSessionID:      "transport-session",
			}
			for key, value := range labels {
				span.Attributes = append(span.Attributes, &commonpb.KeyValue{
					Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
				})
			}
			op, err := appOperationFromOTLPSpan(span)
			if err != nil {
				t.Fatal(err)
			}
			registered := kind == "claude" || kind == "codex"
			if !registered {
				if op.AgentKind != "" || op.SessionID != "" || op.TurnID != "" || op.ToolCallID != "" {
					t.Fatal("unregistered metadata established native identity")
				}
				return
			}
			if op.AgentKind != kind || op.SessionID != "native-conversation" || op.TurnID != "native-turn" || op.ToolCallID != "native-call" {
				t.Fatalf("native identity lost: %+v", op)
			}
			span.Attributes = append(span.Attributes, &commonpb.KeyValue{
				Key: attrSessionID, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 123}},
			})
			op, err = appOperationFromOTLPSpan(span)
			if err != nil || op.SessionID != "" || op.TurnID != "native-turn" {
				t.Fatal("malformed optional metadata discarded observation or adopted transport session")
			}
		})
	}
}

func TestAppNativeOversizedIdentifiers(t *testing.T) {
	for _, key := range []string{attrSessionID, "agentz.turn_id", "gen_ai.tool.call.id"} {
		t.Run(key, func(t *testing.T) {
			span := appSpanFixture(0)
			labels := map[string]string{
				"agentz.agent_kind":   "codex",
				attrSessionID:         "conversation",
				"agentz.turn_id":      "turn",
				"gen_ai.tool.call.id": "call",
			}
			labels[key] = strings.Repeat("λ", 257)
			for name, value := range labels {
				span.Attributes = append(span.Attributes, &commonpb.KeyValue{
					Key: name, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
				})
			}
			op, err := appOperationFromOTLPSpan(span)
			if err != nil {
				t.Fatal(err)
			}
			got := map[string]string{
				attrSessionID: op.SessionID, "agentz.turn_id": op.TurnID, "gen_ai.tool.call.id": op.ToolCallID,
			}
			labels[key] = ""
			for name, value := range got {
				if value != labels[name] {
					t.Errorf("%s = %q, want %q", name, value, labels[name])
				}
			}
			if op.AgentKind != "codex" || !bytes.Contains(op.InputMessages, []byte("messages")) {
				t.Fatal("oversized optional metadata discarded identity or content")
			}
		})
	}
}

type receiverScopeTest struct {
	name    string
	app     bool
	gateway bool
	accept  bool
}

func TestReceiverAttributionBoundary(t *testing.T) {
	tests := []receiverScopeTest{
		{name: "native rejects forged gateway", gateway: true},
		{name: "app accepts gateway", app: true, gateway: true, accept: true},
		{name: "app rejects native", app: true},
		{name: "native accepts agent", accept: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			span := appSpanFixture(0)
			labels := map[string]string{
				attrAgentZAgentName: "test", attrAgentZTenantNamespace: "test", attrSessionID: "session",
			}
			for key, value := range labels {
				span.Attributes = append(span.Attributes, &commonpb.KeyValue{
					Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
				})
			}
			service := "agentz"
			if test.gateway {
				service = "agentz-oauth-gateway"
			}
			request := &tracev1.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
				Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{
					Key: "service.name", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: service}},
				}}},
				ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}},
			}}}
			events := make(chan event, 1)
			receiver := traceReceiver{out: events, stats: &stats{}, app: test.app}
			response, err := receiver.Export(t.Context(), request)
			if err != nil {
				t.Fatal(err)
			}
			if receiver.stats.received != 1 {
				t.Fatal("export did not account for its span")
			}
			if !test.accept {
				if len(events) != 0 || receiver.stats.filtered != 1 || response.GetPartialSuccess().GetRejectedSpans() != 1 {
					t.Fatal("receiver accepted telemetry from the wrong trust boundary")
				}
				return
			}
			if len(events) != 1 || receiver.stats.filtered != 0 || response.GetPartialSuccess() != nil {
				t.Fatal("receiver rejected telemetry from the expected source")
			}
			got := <-events
			if (got.app != nil) != test.app || (got.trace != nil) == test.app {
				t.Fatal("receiver routed telemetry to the wrong storage path")
			}
		})
	}
}
