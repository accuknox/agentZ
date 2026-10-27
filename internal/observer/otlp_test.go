package observer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestGuardrailEvidenceTrustBoundary(t *testing.T) {
	t.Parallel()
	span := appSpanFixture(0)
	evidence := `[{"phase":"request","guard":"webhook","action":"reject","actionReason":"private detector response","agentz":{"retentionDays":3650,"inspected":["private inspected message"]}}]`
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key:   attrGuardrailEvaluations,
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: evidence}},
	})
	request := &tracev1.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{
				Attributes: []*commonpb.KeyValue{{
					Key: "service.name",
					Value: &commonpb.AnyValue{
						Value: &commonpb.AnyValue_StringValue{StringValue: "agentz-oauth-gateway"},
					},
				}},
			},
			ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}},
		}},
	}
	events, rejected := traceEventsFromOTLPRequest(request, false)
	if len(events) != 0 || rejected != 1 {
		t.Fatal("native telemetry listener accepted forged gateway evidence")
	}
	events, rejected = traceEventsFromOTLPRequest(request, true)
	if rejected != 0 || len(events) != 2 || events[0].guardrail == nil || events[1].app == nil {
		t.Fatal("gateway listener did not retain both evaluation and app operation")
	}
	row := events[0].guardrail.row
	if !row.ExpiresAt.IsZero() {
		t.Fatal("native evaluation trusted exporter retention")
	}
	if bytes.Contains(row.Evaluation, []byte("private")) || bytes.Contains(row.Evaluation, []byte("agentz")) {
		t.Fatal("native evaluation retained arbitrary provider text or captured content")
	}

	_, attrs := extractSpanPayload(spanClassLLM, attrsMap(span.Attributes))
	stored, err := json.Marshal(attrs)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("private inspected message")) || bytes.Contains(stored, []byte(attrGuardrailEvaluations)) {
		t.Fatal("guardrail evidence escaped into ordinary trace storage")
	}
}

func appSpanFixture(payloadSize int) *tracepb.Span {
	attributes := map[string]string{
		"agentz.organization_id":    "telemetry-test-org",
		"agentz.workspace_id":       "telemetry-test-workspace",
		"agentz.client_id":          "telemetry-test-client",
		"agentz.app_name":           "Telemetry test",
		"agentz.grant_id":           "telemetry-test-grant",
		"agentz.user_id":            "telemetry-test-user",
		"agentz.resource_kind":      "inference",
		"agentz.resource_namespace": "telemetry-test-namespace",
		"agentz.resource_name":      "provider",
		"agentz.resource_uid":       "provider-uid",
		"agentz.target_id":          "model",
		attrGenAIResponseModel:      "fixture-model",
		"agw.ai.usage.cost.total":   "0.00125",
		attrLLMInputMessages:        `{"messages":[{"role":"user","content":"` + strings.Repeat("x", payloadSize) + `"}]}`,
		attrLLMOutputMessages:       `{"completion":["answer"],"tool_calls":[{"id":"call-1","name":"lookup","arguments":"{\"n\":9007199254740993}"}]}`,
	}
	span := &tracepb.Span{
		TraceId:           bytes.Repeat([]byte{1}, 16),
		SpanId:            bytes.Repeat([]byte{2}, 8),
		Name:              "inference",
		Kind:              tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: uint64(time.Second),
	}
	span.EndTimeUnixNano = span.StartTimeUnixNano + uint64(time.Millisecond)
	for name, value := range attributes {
		span.Attributes = append(span.Attributes, &commonpb.KeyValue{
			Key:   name,
			Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
		})
	}
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key:   attrGenAIInputTokens,
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 0}},
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
		attrMCPMethodName:  "tools/call",
		attrGenAIToolName:  "lookup",
		attrToolParameters: `{"n":9007199254740993}`,
		attrOutputValue:    `{"isError":true,"structuredContent":{"reason":"denied"}}`,
		attrToolError:      `{"code":-32001,"message":"denied","data":{"n":9007199254740993}}`,
	}
	for name, value := range attributes {
		span.Attributes = append(span.Attributes, &commonpb.KeyValue{
			Key:   name,
			Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
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
		Key:   "agentz.workspace_id",
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{}},
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
					Key:   key,
					Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
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
				Key:   attrSessionID,
				Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 123}},
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
					Key:   name,
					Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
				})
			}
			op, err := appOperationFromOTLPSpan(span)
			if err != nil {
				t.Fatal(err)
			}
			got := map[string]string{
				attrSessionID:         op.SessionID,
				"agentz.turn_id":      op.TurnID,
				"gen_ai.tool.call.id": op.ToolCallID,
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
				attrAgentZAgentName:       "test",
				attrAgentZTenantNamespace: "test",
				attrSessionID:             "session",
			}
			for key, value := range labels {
				span.Attributes = append(span.Attributes, &commonpb.KeyValue{
					Key:   key,
					Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}},
				})
			}
			service := "agentz"
			if test.gateway {
				service = "agentz-oauth-gateway"
			}
			request := &tracev1.ExportTraceServiceRequest{
				ResourceSpans: []*tracepb.ResourceSpans{{
					Resource: &resourcepb.Resource{
						Attributes: []*commonpb.KeyValue{{
							Key:   "service.name",
							Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: service}},
						}},
					},
					ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}},
				}},
			}
			events, rejected := traceEventsFromOTLPRequest(request, test.app)
			if !test.accept {
				if len(events) != 0 || rejected != 1 {
					t.Fatal("receiver accepted telemetry from the wrong trust boundary")
				}
				return
			}
			if len(events) != 1 || rejected != 0 {
				t.Fatal("receiver rejected telemetry from the expected source")
			}
			if (events[0].app != nil) != test.app || (events[0].trace != nil) == test.app {
				t.Fatal("receiver accepted attribution for the wrong source")
			}
		})
	}
}

func TestNativeGuardrailIdentityAndMetadata(t *testing.T) {
	t.Parallel()
	span := appSpanFixture(0)
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key: attrGuardrailEvaluations,
		Value: &commonpb.AnyValue{
			Value: &commonpb.AnyValue_StringValue{
				StringValue: `[{"phase":"request","guard":"bedrockGuardrails","action":"mask","guardrailId":"resource","guardrailVersion":"3","actionReason":"secret","assessments":[{"text":"secret"}]},{"phase":"request","guard":"bedrockGuardrails","action":"mask","guardrailId":"resource","guardrailVersion":"3"}]`,
			},
		},
	})
	events, err := guardrailEventsFromSpan(span, nil)
	if err != nil || len(events) != 2 {
		t.Fatalf("native evaluations: %v, %d events", err, len(events))
	}
	replayed, err := guardrailEventsFromSpan(span, nil)
	if err != nil || events[0].row.ID != replayed[0].row.ID || events[0].row.ID == events[1].row.ID {
		t.Fatalf("evaluation identity did not preserve replay and repeated checks: %v", err)
	}
	if events[0].row.EvaluationIndex != 0 || events[1].row.EvaluationIndex != 1 || !bytes.Equal(events[0].row.SpanID, span.SpanId) {
		t.Fatal("native span identity was lost")
	}
	var metadata map[string]string
	if err := json.Unmarshal(events[0].row.Evaluation, &metadata); err != nil {
		t.Fatal(err)
	}
	if len(metadata) != 5 || metadata["phase"] != "request" || metadata["guard"] != "bedrockGuardrails" || metadata["action"] != "mask" || metadata["guardrailId"] != "resource" || metadata["guardrailVersion"] != "3" {
		t.Fatalf("metadata allowlist changed: %s", events[0].row.Evaluation)
	}
	span.SpanId = bytes.Repeat([]byte{3}, 8)
	other, err := guardrailEventsFromSpan(span, nil)
	if err != nil || other[0].row.ID == events[0].row.ID {
		t.Fatal("two spans in the same trace shared an evaluation identity")
	}
}

type nativeGuardrailEvidenceCase struct {
	name   string
	change func(*tracepb.Span)
}

func TestNativeGuardrailInvalidEvidence(t *testing.T) {
	t.Parallel()
	cases := []nativeGuardrailEvidenceCase{
		{
			name:   "zero trace",
			change: func(sp *tracepb.Span) { sp.TraceId = make([]byte, 16) },
		},
		{name: "short span", change: func(sp *tracepb.Span) { sp.SpanId = []byte{1} }},
		{
			name:   "zero span",
			change: func(sp *tracepb.Span) { sp.SpanId = make([]byte, 8) },
		},
		{
			name:   "missing occurrence",
			change: func(sp *tracepb.Span) { sp.StartTimeUnixNano = 0 },
		},
		{
			name:   "future occurrence",
			change: func(sp *tracepb.Span) { sp.StartTimeUnixNano = uint64(time.Now().Add(time.Hour).UnixNano()) },
		},
		{
			name: "invalid phase",
			change: func(sp *tracepb.Span) {
				sp.Attributes[len(sp.Attributes)-1].Value = &commonpb.AnyValue{
					Value: &commonpb.AnyValue_StringValue{
						StringValue: `[{"phase":"unknown","guard":"regex","action":"reject"}]`,
					},
				}
			},
		},
		{
			name: "invalid verdict",
			change: func(sp *tracepb.Span) {
				sp.Attributes[len(sp.Attributes)-1].Value = &commonpb.AnyValue{
					Value: &commonpb.AnyValue_StringValue{
						StringValue: `[{"phase":"request","guard":"regex","action":"unknown"}]`,
					},
				}
			},
		},
		{
			name: "missing namespace",
			change: func(sp *tracepb.Span) {
				for _, attr := range sp.Attributes {
					if attr.Key == "agentz.resource_namespace" {
						attr.Value = nil
					}
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			span := appSpanFixture(0)
			span.Attributes = append(span.Attributes, &commonpb.KeyValue{
				Key: attrGuardrailEvaluations,
				Value: &commonpb.AnyValue{
					Value: &commonpb.AnyValue_StringValue{
						StringValue: `[{"phase":"request","guard":"regex","action":"reject"}]`,
					},
				},
			})
			tc.change(span)
			if _, err := guardrailEventsFromSpan(span, nil); err == nil {
				t.Fatal("invalid native evidence was accepted")
			}
		})
	}
}

func guardrailSpanFixture(evaluations string) *tracepb.Span {
	span := appSpanFixture(0)
	span.Attributes = append(span.Attributes, &commonpb.KeyValue{
		Key: attrGuardrailEvaluations,
		Value: &commonpb.AnyValue{
			Value: &commonpb.AnyValue_StringValue{StringValue: evaluations},
		},
	})
	return span
}

func TestGuardrailEventsOnlyInterventions(t *testing.T) {
	t.Parallel()
	for _, phase := range []string{"request", "response"} {
		for _, action := range []string{"allow", "reject", "mask", "audit", "failOpen"} {
			t.Run(phase+"/"+action, func(t *testing.T) {
				raw := fmt.Sprintf(`[{"phase":%q,"guard":"regex","action":%q}]`, phase, action)
				span := guardrailSpanFixture(raw)
				rows, err := guardrailEventsFromSpan(span, nil)
				if err != nil {
					t.Fatal(err)
				}
				if action == "allow" {
					if len(rows) != 0 {
						t.Fatal("successful check produced a guardrail event")
					}
					return
				}
				if len(rows) != 1 || rows[0].row.Action != action || rows[0].row.Phase != phase {
					t.Fatalf("intervention lost: rows=%+v", rows)
				}
			})
		}
	}
}

func TestGuardrailEventsEmptyLog(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"", "null", "[]", `[{"phase":"request","guard":"regex","action":"allow"}]`} {
		t.Run(raw, func(t *testing.T) {
			span := &tracepb.Span{
				Kind:       tracepb.Span_SPAN_KIND_SERVER,
				Attributes: guardrailSpanFixture(raw).Attributes,
			}
			rows, err := guardrailEventsFromSpan(span, nil)
			if err != nil || len(rows) != 0 {
				t.Fatalf("empty intervention log required event identity: rows=%d err=%v", len(rows), err)
			}
		})
	}
}

func TestGuardrailEventsMixedOutcomes(t *testing.T) {
	t.Parallel()
	span := guardrailSpanFixture(`[
		{"phase":"request","guard":"regex","action":"allow"},
		{"phase":"request","guard":"regex","action":"mask"},
		{"phase":"response","guard":"webhook","action":"allow"},
		{"phase":"response","guard":"webhook","action":"reject"}
	]`)
	rows, err := guardrailEventsFromSpan(span, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].row.Action != "mask" || rows[1].row.Action != "reject" {
		t.Fatalf("mixed export retained successful checks or lost interventions: %+v", rows)
	}
	if rows[0].row.EvaluationIndex != 1 || rows[1].row.EvaluationIndex != 3 {
		t.Fatal("filtering changed the evaluation identities used for replay deduplication")
	}
}

func BenchmarkGuardrailInterventions(b *testing.B) {
	allow := `{"phase":"request","guard":"regex","action":"allow"}`
	reject := `{"phase":"request","guard":"regex","action":"reject"}`
	cases := map[string]string{
		"no_evidence":        "null",
		"empty":              "[]",
		"ten_allows":         "[" + strings.TrimSuffix(strings.Repeat(allow+",", 10), ",") + "]",
		"one_reject":         "[" + reject + "]",
		"one_percent_reject": "[" + strings.Repeat(allow+",", 99) + reject + "]",
	}
	for name, evaluations := range cases {
		b.Run(name, func(b *testing.B) {
			span := guardrailSpanFixture(evaluations)
			b.ReportAllocs()
			for b.Loop() {
				if _, err := guardrailEventsFromSpan(span, nil); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
