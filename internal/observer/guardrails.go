package observer

import (
	"bytes"
	"cmp"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	observerdb "github.com/accuknox/agentz/internal/observer/db"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

const attrGuardrailEvaluations = "agentz.guardrails"

type guardrailEvent struct {
	row       observerdb.InsertGuardrailEventParams
	namespace string
}

// guardrailEventsFromSpan retains interventions from the gateway-only listener.
func guardrailEventsFromSpan(sp *tracepb.Span, resourceAttrs map[string]*commonpb.AnyValue) ([]guardrailEvent, error) {
	if sp.GetKind() != tracepb.Span_SPAN_KIND_SERVER {
		return nil, nil
	}
	// Successful checks have no evidence at the source. Avoid allocating an
	// attribute map or decoding JSON on that common path.
	var raw string
	for _, attr := range sp.GetAttributes() {
		if attr.GetKey() == attrGuardrailEvaluations {
			raw = attr.GetValue().GetStringValue()
			break
		}
	}
	if raw == "" || raw == "null" || raw == "[]" {
		return nil, nil
	}
	var evaluations []gatewayapi.GuardrailRuntimeEvaluation
	if err := json.Unmarshal([]byte(raw), &evaluations); err != nil {
		return nil, fmt.Errorf("decode guardrail evaluations: %w", err)
	}
	retained := 0
	for _, evaluation := range evaluations {
		if evaluation.Action != "allow" {
			retained++
		}
	}
	if retained == 0 {
		return nil, nil
	}
	invalidTrace := len(sp.GetTraceId()) != 16 || bytes.Equal(sp.GetTraceId(), make([]byte, 16))
	invalidSpan := len(sp.GetSpanId()) != 8 || bytes.Equal(sp.GetSpanId(), make([]byte, 8))
	if invalidTrace || invalidSpan {
		return nil, errors.New("guardrail evaluation has invalid trace or span identity")
	}
	if sp.GetStartTimeUnixNano() == 0 || sp.GetStartTimeUnixNano() > uint64(time.Now().Add(time.Minute).UnixNano()) {
		return nil, errors.New("guardrail evaluation has an invalid occurrence time")
	}
	attrs := attrsMap(sp.GetAttributes())
	namespace := cmp.Or(
		attrs[attrAgentZTenantNamespace].GetStringValue(),
		attrs["agentz.resource_namespace"].GetStringValue(),
		resourceAttrs[attrServiceNamespace].GetStringValue(),
	)
	if namespace == "" {
		return nil, errors.New("guardrail evaluation has no gateway-owned namespace")
	}
	traceID := hex.EncodeToString(sp.GetTraceId())
	spanID := hex.EncodeToString(sp.GetSpanId())
	events := make([]guardrailEvent, 0, retained)
	for index, evaluation := range evaluations {
		if evaluation.Action == "allow" {
			continue
		}
		validPhase := evaluation.Phase == gatewayapi.GuardrailRuntimeEvaluationPhaseRequest ||
			evaluation.Phase == gatewayapi.GuardrailRuntimeEvaluationPhaseResponse
		if !validPhase {
			return nil, errors.New("guardrail evaluation has an invalid phase")
		}
		switch evaluation.Action {
		case gatewayapi.GuardrailRuntimeEvaluationActionFailOpen,
			gatewayapi.GuardrailRuntimeEvaluationActionAudit,
			gatewayapi.GuardrailRuntimeEvaluationActionMask,
			gatewayapi.GuardrailRuntimeEvaluationActionReject:
		default:
			return nil, errors.New("guardrail evaluation has an invalid action")
		}
		if evaluation.Guard == "" {
			return nil, errors.New("guardrail evaluation has no guard kind")
		}
		// The generated type excludes inspected content and provider diagnostics.
		encoded, err := json.Marshal(evaluation)
		if err != nil {
			return nil, fmt.Errorf("encode guardrail evaluation: %w", err)
		}
		row := observerdb.InsertGuardrailEventParams{
			ID:              fmt.Sprintf("%s:%s:%d", traceID, spanID, index),
			OrganizationID:  attrs["agentz.organization_id"].GetStringValue(),
			WorkspaceID:     attrs["agentz.workspace_id"].GetStringValue(),
			OccurredAt:      time.Unix(0, int64(sp.GetStartTimeUnixNano())),
			SandboxName:     attrs["agentz.sandbox_name"].GetStringValue(),
			AgentName:       attrs[attrAgentZAgentName].GetStringValue(),
			ClientID:        attrs["agentz.client_id"].GetStringValue(),
			SessionID:       attrs[attrSessionID].GetStringValue(),
			Model:           cmp.Or(attrs[attrGenAIResponseModel].GetStringValue(), attrs[attrGenAIRequestModel].GetStringValue()),
			TraceID:         slices.Clone(sp.GetTraceId()),
			SpanID:          slices.Clone(sp.GetSpanId()),
			EvaluationIndex: int32(index),
			Revision:        attrs["agentz.guardrail_revision"].GetStringValue(),
			Phase:           string(evaluation.Phase),
			Action:          string(evaluation.Action),
			Evaluation:      encoded,
		}
		events = append(events, guardrailEvent{row: row, namespace: namespace})
	}
	return events, nil
}
