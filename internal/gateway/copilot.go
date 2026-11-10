package gateway

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	observerdb "github.com/accuknox/agentz/internal/observer/db"
	api "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// ingestCopilot accepts the documented OTLP protocol. Caller-controlled resource
// labels never establish authority; the live registration and grant own scope.
func (s *Service) ingestCopilot(w http.ResponseWriter, r *http.Request, grant gatewaydb.DelegationGrant, catalog gatewayapi.DelegationCatalog) {
	if r.Header.Get("Origin") != "" {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "Native telemetry requires a local client.")
		return
	}
	agent, err := s.queries.GatewayGetExternalAgent(r.Context(), grant.ClientID)
	copilot := agent.Kind == gatewaydb.ExternalAgentKindGithubCopilotCli || agent.Kind == gatewaydb.ExternalAgentKindGithubCopilotDesktop
	if err != nil || !copilot || agent.UserID != grant.UserID {
		s.delegationError(w, r, http.StatusForbidden, "access_denied", "A registered Copilot client is required.")
		return
	}
	if r.Header.Get("Content-Type") != "application/x-protobuf" {
		s.delegationError(w, r, http.StatusUnsupportedMediaType, "invalid_request", "Use OTLP HTTP protobuf.")
		return
	}
	// Bound both a single batch and aggregate concurrent input, as for inference.
	const limit = 32 << 20
	if r.ContentLength > limit {
		s.delegationError(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "The telemetry batch exceeds the gateway limit.")
		return
	}
	if !s.delegationBodies.TryAcquire(limit) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	defer s.delegationBodies.Release(limit)
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.delegationError(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "The telemetry batch exceeds the gateway limit.")
		return
	}
	var batch tracev1.ExportTraceServiceRequest
	if err := proto.Unmarshal(body, &batch); err != nil {
		s.delegationError(w, r, http.StatusBadRequest, "invalid_request", "Invalid OTLP trace batch.")
		return
	}
	// Model and orchestration exports do not need another resource's grants.
	// Resolve MCP authority once, only if this batch actually executes MCP.
	mcpTools := sync.OnceValues(func() (map[string]gatewayapi.DelegationMCP, error) {
		selections, err := s.queries.GatewayListExternalAgentMCP(r.Context(), gatewaydb.GatewayListExternalAgentMCPParams{
			ClientID:       agent.ClientID,
			UserID:         agent.UserID,
			OrganizationID: pgtype.Text{String: agent.OrganizationID, Valid: true},
		})
		if err != nil {
			return nil, err
		}
		tools := make(map[string]gatewayapi.DelegationMCP)
		for _, selection := range selections {
			var approved gatewayapi.DelegationCatalog
			if err := json.Unmarshal(selection, &approved); err != nil {
				return nil, err
			}
			approved.Models = nil
			if _, err := s.resolveDelegation(r.Context(), grant, approved); err != nil {
				continue
			}
			for _, connection := range approved.Mcp {
				for _, tool := range connection.Tools {
					tools[connection.Id+"_"+tool] = connection
				}
			}
		}
		return tools, nil
	})
	var rows []observerdb.InsertNativeAppOperationParams
	var traces [][]byte
	var keys []string
	var rejected int64
	for _, resource := range batch.GetResourceSpans() {
		for _, scope := range resource.GetScopeSpans() {
			for _, span := range scope.GetSpans() {
				row, err := copilotOperation(span, agent, grant.ID, catalog.Models, mcpTools)
				if err != nil {
					apiutil.WriteInternalError(w, r, err)
					return
				}
				if row == nil {
					rejected++
					continue
				}
				rows = append(rows, *row)
				traces = append(traces, row.TraceID)
				keys = append(keys, "copilot:"+agent.ClientID+":"+hex.EncodeToString(row.TraceID))
			}
		}
	}
	if len(rows) > 0 {
		tx, err := s.db.Begin(r.Context())
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		queries := observerdb.New(tx)
		// Serialize exports of the same trace so a late root repairs children
		// even when the native exporter sends them in concurrent batches.
		if err := queries.LockAppInvocationKeys(r.Context(), keys); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		queries.InsertNativeAppOperation(r.Context(), rows).QueryRow(func(_ int, _ int64, next error) {
			err = errors.Join(err, next)
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		err = queries.AssignNativeRuns(r.Context(), observerdb.AssignNativeRunsParams{
			OrganizationID: agent.OrganizationID,
			WorkspaceID:    agent.WorkspaceID,
			ClientID:       agent.ClientID,
			TraceIds:       traces,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	response := &tracev1.ExportTraceServiceResponse{}
	if rejected > 0 {
		response.PartialSuccess = &tracev1.ExportTracePartialSuccess{
			RejectedSpans: rejected,
			ErrorMessage:  "Spans must contain valid native Copilot identifiers and approved models.",
		}
	}
	data, err := proto.Marshal(response)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Write(data)
}

// copilotOperation projects native fields under the registered agent's scope.
// A nil operation rejects a span without failing the rest of its batch.
func copilotOperation(span *tracepb.Span, agent gatewaydb.ExternalAgent, grantID string, models []gatewayapi.DelegationModel, mcpTools func() (map[string]gatewayapi.DelegationMCP, error)) (*observerdb.InsertNativeAppOperationParams, error) {
	var zeroTrace [16]byte
	var zeroSpan [8]byte
	attrs := make(map[string]*commonpb.AnyValue, len(span.GetAttributes()))
	for _, attr := range span.GetAttributes() {
		attrs[attr.GetKey()] = attr.GetValue()
	}
	session := attrs["gen_ai.conversation.id"].GetStringValue()
	call := attrs["gen_ai.tool.call.id"].GetStringValue()
	parent := len(span.GetParentSpanId())
	validIDs := len(span.GetTraceId()) == 16 && len(span.GetSpanId()) == 8 && (parent == 0 || parent == 8)
	// OTLP IDs must contain a nonzero byte; length alone also
	// admits invalid roots and parent links that Lens cannot join.
	validIDs = validIDs && !bytes.Equal(span.GetTraceId(), zeroTrace[:])
	validIDs = validIDs && !bytes.Equal(span.GetSpanId(), zeroSpan[:])
	validIDs = validIDs && !bytes.Equal(span.GetParentSpanId(), zeroSpan[:])
	validTime := span.GetStartTimeUnixNano() <= math.MaxInt64 && span.GetEndTimeUnixNano() <= math.MaxInt64
	validTime = validTime && span.GetEndTimeUnixNano() >= span.GetStartTimeUnixNano()
	if !validIDs || !validTime || session == "" || len(session) > 512 || len(call) > 512 {
		return nil, nil
	}
	namespace := api.ScopeNamespace(api.ResourceScopeWorkspace, agent.WorkspaceID)
	row := observerdb.InsertNativeAppOperationParams{
		OrganizationID:    agent.OrganizationID,
		WorkspaceID:       agent.WorkspaceID,
		ClientID:          agent.ClientID,
		AppName:           agent.ClientID,
		GrantID:           grantID,
		UserID:            agent.UserID,
		ResourceNamespace: namespace,
		ResourceName:      agent.ClientID,
		ResourceUid:       agent.ClientID,
		TargetID:          agent.ClientID,
		TraceID:           span.GetTraceId(),
		SpanID:            span.GetSpanId(),
		ParentSpanID:      append([]byte{}, span.GetParentSpanId()...),
		StartTime:         time.Unix(0, int64(span.GetStartTimeUnixNano())),
		EndTime:           time.Unix(0, int64(span.GetEndTimeUnixNano())),
		DurationNs:        int64(span.GetEndTimeUnixNano() - span.GetStartTimeUnixNano()),
		Name:              span.GetName(),
		OperationName:     attrs["gen_ai.operation.name"].GetStringValue(),
		StatusCode:        "OK",
		ErrorType:         attrs["error.type"].GetStringValue(),
		ErrorMessage:      span.GetStatus().GetMessage(),
		Model:             attrs["gen_ai.request.model"].GetStringValue(),
		ToolName:          attrs["gen_ai.tool.name"].GetStringValue(),
		SessionID:         session,
		AgentKind:         string(agent.Kind),
		ToolCallID:        call,
	}
	if span.GetStatus().GetCode() == tracepb.Status_STATUS_CODE_ERROR || row.ErrorType != "" {
		row.StatusCode = "ERROR"
	}
	switch row.OperationName {
	case "invoke_agent":
		row.ResourceKind, row.SpanClass = "agent", "session"
		if len(row.ParentSpanID) == 0 {
			row.ResourceKind = "turn"
			row.TurnID = hex.EncodeToString(row.SpanID)
		}
	case "plan":
		row.ResourceKind, row.SpanClass = "agent", "session"
	case "chat":
		row.ResourceKind, row.SpanClass = "inference", "llm"
		selected := false
		for _, model := range models {
			if model.Id != row.Model {
				continue
			}
			row.ResourceNamespace, row.ResourceName = model.Namespace, model.Provider
			row.ResourceUid, row.TargetID = model.Uid, model.Id
			row.Model, selected = model.Model, true
			break
		}
		if !selected {
			return nil, nil
		}
		usage := map[string]*pgtype.Int8{
			"gen_ai.usage.input_tokens":             &row.InputTokens,
			"gen_ai.usage.output_tokens":            &row.OutputTokens,
			"gen_ai.usage.cache_read.input_tokens":  &row.CachedInputTokens,
			"gen_ai.usage.cache_write.input_tokens": &row.CachedWriteTokens,
		}
		for name, target := range usage {
			value, ok := attrs[name].GetValue().(*commonpb.AnyValue_IntValue)
			if ok && value.IntValue >= 0 {
				*target = pgtype.Int8{Int64: value.IntValue, Valid: true}
			}
		}
	case "execute_tool":
		row.ResourceKind, row.SpanClass = "tool", "tool"
		// gen_ai.tool.name is Copilot's display alias.
		// The MCP parameters preserve the full exported identity.
		server := attrs["github.copilot.tool.parameters.mcp_server_name"].GetStringValue()
		tool := attrs["github.copilot.tool.parameters.mcp_tool_name"].GetStringValue()
		if server != "agentz" {
			break
		}
		tools, err := mcpTools()
		if err != nil {
			return nil, err
		}
		connection, approved := tools[tool]
		if !approved {
			break
		}
		row.ResourceKind = "mcp"
		row.ResourceNamespace = connection.Namespace
		row.ResourceName = connection.Connection
		row.ResourceUid = connection.Uid
		row.TargetID = connection.Id
		row.ToolName = strings.TrimPrefix(tool, connection.Id+"_")
	default:
		return nil, nil
	}
	payloads := map[string]*[]byte{
		"gen_ai.input.messages":      &row.InputMessages,
		"gen_ai.output.messages":     &row.OutputMessages,
		"gen_ai.tool.call.arguments": &row.ToolArguments,
		"gen_ai.tool.call.result":    &row.ToolResult,
	}
	for name, target := range payloads {
		*target = []byte("null")
		value := []byte(attrs[name].GetStringValue())
		if json.Valid(value) {
			*target = value
		}
	}
	row.ToolError = []byte("null")
	if row.StatusCode == "ERROR" && row.SpanClass == "tool" {
		row.ToolError, _ = json.Marshal(row.ErrorMessage)
	}
	return &row, nil
}

// ExportExternalAgentTraces applies the inference grant before accepting native telemetry.
func (s *Service) ExportExternalAgentTraces(w http.ResponseWriter, r *http.Request) {
	s.handleDelegatedRequest(w, r)
}
