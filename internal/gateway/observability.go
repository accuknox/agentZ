package gateway

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const mcpGraphAgentNodePrefix = "agent:"

type observabilityRequest struct {
	agentName string
	namespace string
	limit     int
}

func (s *Service) authorizeObservability(w http.ResponseWriter, r *http.Request, agentName string) (string, bool) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return "", false
	}

	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	}
	if !access.effective.Allows(scope, authorization.OperationReadObservability) {
		writeError(w, r, resourceForbidden(errors.New("effective Observability permission is missing")))
		return "", false
	}
	return access.namespace, true
}

func (s *Service) observabilityRequest(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, limit *gatewayapi.LimitQuery) (observabilityRequest, bool) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return observabilityRequest{}, false
	}
	namespace, ok := s.authorizeObservability(w, r, agentName)
	if !ok {
		return observabilityRequest{}, false
	}
	pageSize, ok := validLimit(w, r, limit)
	if !ok {
		return observabilityRequest{}, false
	}
	return observabilityRequest{
		agentName: agentName,
		namespace: namespace,
		limit:     pageSize,
	}, true
}

// ListTraceSessions handles GET /api/lens/{agentName}/{sessionID}/trace.
func (s *Service) ListTraceSessions(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, sessionID string, params gatewayapi.ListTraceSessionsParams) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	ns, ok := s.authorizeObservability(w, r, agentName)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeTraceSessionPageToken(w, r, params.PageToken)
	if !ok {
		return
	}
	cursorTraceID, ok := decodeOptionalTraceCursor(w, r, cursor.TraceID, cursorSet)
	if !ok {
		return
	}
	startedAfter, startedBefore, ok := traceTimeBounds(w, r, params.StartedAfter, params.StartedBefore)
	if !ok {
		return
	}

	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "sessionID", Message: "required"},
		))
		return
	}

	rows, err := s.queries.GatewayListTraceSessions(r.Context(), gatewaydb.GatewayListTraceSessionsParams{
		TenantNamespace: ns,
		AgentName:       agentName,
		SessionID:       pgtype.Text{String: sessionID, Valid: true},
		StartedAfter:    startedAfter,
		StartedBefore:   startedBefore,
		CursorSet:       cursorSet,
		CursorStartedAt: cursor.StartedAt,
		CursorTraceID:   cursorTraceID,
		CursorSessionID: cursor.SessionID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.TraceSession, 0, limit)
	var next string
	for i, row := range rows {
		if i == limit {
			last := rows[limit-1]
			next = encodeCursorPageToken(traceSessionPageCursor{
				StartedAt: last.StartedAt,
				TraceID:   hex.EncodeToString(last.TraceID),
				SessionID: last.SessionID,
			})
			break
		}
		items = append(items, gatewayapi.TraceSession{
			TraceId:           hex.EncodeToString(row.TraceID),
			SessionId:         row.SessionID,
			AgentName:         row.AgentName,
			RootSpanId:        hex.EncodeToString(row.RootSpanID),
			StartedAt:         row.StartedAt,
			EndedAt:           row.EndedAt,
			DurationNs:        row.DurationNs,
			DurationMs:        float64(row.DurationNs) / float64(time.Millisecond),
			SpanCount:         row.SpanCount,
			ErrorCount:        row.ErrorCount,
			ToolCount:         row.ToolCount,
			ModelCount:        row.ModelCount,
			InputTokens:       row.InputTokens,
			OutputTokens:      row.OutputTokens,
			CachedInputTokens: row.CachedInputTokens,
			CachedWriteTokens: row.CachedWriteTokens,
			CostUsd:           row.CostUsd,
			StatusCode:        row.StatusCode,
			UpdatedAt:         row.UpdatedAt,
		})
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListTraceSessionsResponse{
		TraceSessions: items,
		NextPageToken: next,
	})
}

// ListSpans handles GET /api/lens/{agentName}/{sessionID}/trace/{traceID}/span.
func (s *Service) ListSpans(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, sessionID string, traceID gatewayapi.TraceID, params gatewayapi.ListSpansParams) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	ns, ok := s.authorizeObservability(w, r, agentName)
	if !ok {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "sessionID", Message: "required"},
		))
		return
	}
	traceIDBytes, ok := validTraceID(w, r, traceID)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeSpanPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListSpans(r.Context(), gatewaydb.GatewayListSpansParams{
		TenantNamespace: ns,
		AgentName:       agentName,
		TraceID:         traceIDBytes,
		CursorSet:       cursorSet,
		CursorStartTime: cursor.StartTime,
		CursorID:        cursor.ID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.Span, 0, limit)
	var next string
	for i, row := range rows {
		if i == limit {
			last := rows[limit-1]
			next = encodeCursorPageToken(spanPageCursor{
				StartTime: last.StartTime,
				ID:        last.ID,
			})
			break
		}
		items = append(items, spanFromListRow(row))
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListSpansResponse{
		Spans:         items,
		NextPageToken: next,
	})
}

// GetSpanDetail handles GET /api/lens/{agentName}/{sessionID}/trace/{traceID}/span/{spanID}.
func (s *Service) GetSpanDetail(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, sessionID string, traceID gatewayapi.TraceID, spanID gatewayapi.SpanID) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	ns, ok := s.authorizeObservability(w, r, agentName)
	if !ok {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			gatewayapi.FieldError{Field: "sessionID", Message: "required"},
		))
		return
	}
	traceIDBytes, ok := validTraceID(w, r, traceID)
	if !ok {
		return
	}
	spanIDBytes, ok := validSpanID(w, r, spanID)
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetSpanDetail(r.Context(), gatewaydb.GatewayGetSpanDetailParams{
		TenantNamespace: ns,
		AgentName:       agentName,
		TraceID:         traceIDBytes,
		SpanID:          spanIDBytes,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"span not found",
				err,
			))
			return
		}
		writeInternalError(w, r, err)
		return
	}

	payload, ok := spanPayload(w, r, row)
	if !ok {
		return
	}

	span, ok := spanDetailFromRow(w, r, row)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, gatewayapi.SpanDetailResponse{
		Span:    span,
		Payload: payload,
	})
}

// GetMCPGraph handles GET /api/lens/{agentName}/mcp/graph.
func (s *Service) GetMCPGraph(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.GetMCPGraphParams) {
	agentName, ok := validAgentName(w, r, agentName, "agentName")
	if !ok {
		return
	}
	ns, ok := s.authorizeObservability(w, r, agentName)
	if !ok {
		return
	}
	exists, err := s.queries.GatewayAgentExists(r.Context(), gatewaydb.GatewayAgentExistsParams{
		TenantNamespace: ns,
		AgentName:       agentName,
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"agent not found",
			errAgentNotFound,
		))
		return
	}

	startTime := params.From.UTC()
	endTime := params.To.Time.UTC().Add(24 * time.Hour)
	if !startTime.Before(endTime) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"from must be before or equal to to",
			errBadRequest,
		))
		return
	}

	rows, err := s.queries.GatewayGetMCPGraph(r.Context(), gatewaydb.GatewayGetMCPGraphParams{
		TenantNamespace: ns,
		AgentName:       agentName,
		StartTimeAfter:  startTime,
		StartTimeBefore: endTime,
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentID := mcpGraphAgentNodePrefix + agentName
	connectionURLs, err := s.mcpConnectionURLsByName(ns, rows)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	connections := make([]gatewayapi.MCPGraphConnection, 0, len(rows))
	tools := make([]gatewayapi.MCPGraphTool, 0, len(rows))
	edges := make([]gatewayapi.MCPGraphEdge, 0, len(rows)*2)
	connectionIDs := make(map[string]string, len(rows))
	toolIDs := make(map[string]string, len(rows))

	for _, row := range rows {
		connectionID, ok := connectionIDs[row.McpConnectionName]
		if !ok {
			connectionID = "connection:" + row.McpConnectionName
			connectionIDs[row.McpConnectionName] = connectionID
			connection := gatewayapi.MCPGraphConnection{
				Id:   connectionID,
				Name: row.McpConnectionName,
			}
			if serverURL, found := connectionURLs[row.McpConnectionName]; found {
				connection.ServerUrl = &serverURL
			}
			connections = append(connections, connection)
			edges = append(edges, gatewayapi.MCPGraphEdge{
				Source: agentID,
				Target: connectionID,
				Kind:   gatewayapi.AgentConnection,
			})
		}

		toolKey := row.McpConnectionName + "\x00" + row.ToolName
		toolID, ok := toolIDs[toolKey]
		if !ok {
			toolID = fmt.Sprintf("tool:%s:%s", row.McpConnectionName, row.ToolName)
			toolIDs[toolKey] = toolID
			tools = append(tools, gatewayapi.MCPGraphTool{
				Id:           toolID,
				ConnectionId: connectionID,
				Name:         row.ToolName,
			})
		}

		edge := gatewayapi.MCPGraphEdge{
			Source:       connectionID,
			Target:       toolID,
			Kind:         gatewayapi.ConnectionTool,
			AvgLatencyMs: &row.AvgLatencyMs,
			SuccessCount: &row.SuccessCount,
			FailedCount:  &row.FailedCount,
		}
		if row.LastCalledAt.Valid {
			lastCalledAt := row.LastCalledAt.Time.UTC()
			edge.LastCalledAt = &lastCalledAt
		}
		edges = append(edges, edge)
	}

	writeJSON(w, http.StatusOK, gatewayapi.MCPGraphResponse{
		Agent: gatewayapi.MCPGraphAgent{
			Name: agentName,
		},
		Connections: connections,
		Tools:       tools,
		Edges:       edges,
	})
}

// mcpConnectionURLsByName returns MCP connection endpoint URLs keyed by
// resource name for the graph rows currently being rendered.
func (s *Service) mcpConnectionURLsByName(namespace string, rows []gatewaydb.GatewayGetMCPGraphRow) (map[string]string, error) {
	if len(rows) == 0 {
		return map[string]string{}, nil
	}

	names := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		names[row.McpConnectionName] = struct{}{}
	}

	conns, err := s.listMCPConnections(namespace)
	if err != nil {
		return nil, err
	}

	urls := make(map[string]string, len(names))
	for _, conn := range conns {
		if _, ok := names[conn.Name]; !ok {
			continue
		}
		urls[conn.Name] = conn.Spec.Endpoint.URL
	}

	return urls, nil
}

// ListProcessObservability handles raw process events for one Agent.
func (s *Service) ListProcessObservability(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListProcessObservabilityParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}

	after, before, action, cursor, cursorSet, ok := observabilityListParams(
		w,
		r,
		params.EventTimeAfter,
		params.EventTimeBefore,
		params.Action,
		params.PageToken,
	)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListProcessEvents(r.Context(), gatewaydb.GatewayListProcessEventsParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, req.limit, processEvent, processCursor)
	writeJSON(w, http.StatusOK, gatewayapi.ListProcessObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

// ListProcessObservabilitySummary handles aggregated process events for one Agent.
func (s *Service) ListProcessObservabilitySummary(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListProcessObservabilitySummaryParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}
	after, before, action, ok := observabilityFilters(
		w, r, &params.EventTimeAfter, &params.EventTimeBefore, params.Action,
	)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListProcessEventsAggregated(r.Context(), gatewaydb.GatewayListProcessEventsAggregatedParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.LastSeen,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(
		rows,
		req.limit,
		processAggregatedEvent,
		func(row gatewaydb.GatewayListProcessEventsAggregatedRow) aggregatedEventPageCursor {
			return aggregatedEventPageCursor{LastSeen: row.LastSeen}
		},
	)
	writeJSON(w, http.StatusOK, gatewayapi.ListProcessObservabilitySummaryResponse{
		Events:        items,
		NextPageToken: next,
	})
}

// ListFileObservability handles raw file events for one Agent.
func (s *Service) ListFileObservability(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListFileObservabilityParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}

	after, before, action, cursor, cursorSet, ok := observabilityListParams(
		w,
		r,
		params.EventTimeAfter,
		params.EventTimeBefore,
		params.Action,
		params.PageToken,
	)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListFileEvents(r.Context(), gatewaydb.GatewayListFileEventsParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, req.limit, fileEvent, fileCursor)
	writeJSON(w, http.StatusOK, gatewayapi.ListFileObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

// ListFileObservabilitySummary handles aggregated file events for one Agent.
func (s *Service) ListFileObservabilitySummary(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListFileObservabilitySummaryParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}
	after, before, action, ok := observabilityFilters(
		w, r, &params.EventTimeAfter, &params.EventTimeBefore, params.Action,
	)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListFileEventsAggregated(r.Context(), gatewaydb.GatewayListFileEventsAggregatedParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.LastSeen,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(
		rows,
		req.limit,
		fileAggregatedEvent,
		func(row gatewaydb.GatewayListFileEventsAggregatedRow) aggregatedEventPageCursor {
			return aggregatedEventPageCursor{LastSeen: row.LastSeen}
		},
	)
	writeJSON(w, http.StatusOK, gatewayapi.ListFileObservabilitySummaryResponse{
		Events:        items,
		NextPageToken: next,
	})
}

// ListNetworkObservability handles raw network events for one Agent.
func (s *Service) ListNetworkObservability(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListNetworkObservabilityParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}

	after, before, action, cursor, cursorSet, ok := observabilityListParams(
		w,
		r,
		params.EventTimeAfter,
		params.EventTimeBefore,
		params.Action,
		params.PageToken,
	)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListNetworkEvents(r.Context(), gatewaydb.GatewayListNetworkEventsParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, req.limit, networkEvent, networkCursor)
	writeJSON(w, http.StatusOK, gatewayapi.ListNetworkObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

// ListNetworkObservabilitySummary handles aggregated network events for one Agent.
func (s *Service) ListNetworkObservabilitySummary(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListNetworkObservabilitySummaryParams) {
	req, ok := s.observabilityRequest(w, r, agentName, params.Limit)
	if !ok {
		return
	}
	after, before, action, ok := observabilityFilters(
		w, r, &params.EventTimeAfter, &params.EventTimeBefore, params.Action,
	)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	rows, err := s.queries.GatewayListNetworkEventsAggregated(r.Context(), gatewaydb.GatewayListNetworkEventsAggregatedParams{
		TenantNamespace: req.namespace,
		AgentName:       req.agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.LastSeen,
		PageSize:        int32(req.limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(
		rows,
		req.limit,
		networkAggregatedEvent,
		func(row gatewaydb.GatewayListNetworkEventsAggregatedRow) aggregatedEventPageCursor {
			return aggregatedEventPageCursor{LastSeen: row.LastSeen}
		},
	)
	writeJSON(w, http.StatusOK, gatewayapi.ListNetworkObservabilitySummaryResponse{
		Events:        items,
		NextPageToken: next,
	})
}

func spanFromListRow(row gatewaydb.GatewayListSpansRow) gatewayapi.Span {
	return gatewayapi.Span{
		Id:                row.ID,
		AgentName:         row.AgentName,
		SessionId:         row.SessionID,
		TraceId:           hex.EncodeToString(row.TraceID),
		SpanId:            hex.EncodeToString(row.SpanID),
		ParentSpanId:      hex.EncodeToString(row.ParentSpanID),
		StartTime:         row.StartTime,
		EndTime:           row.EndTime,
		DurationNs:        row.DurationNs,
		DurationMs:        float64(row.DurationNs) / float64(time.Millisecond),
		Name:              row.Name,
		SpanClass:         row.SpanClass,
		OperationName:     row.OperationName,
		Kind:              row.Kind,
		StatusCode:        row.StatusCode,
		ErrorType:         row.ErrorType,
		ErrorMessage:      row.ErrorMessage,
		Model:             row.Model,
		ToolName:          row.ToolName,
		InputTokens:       row.InputTokens,
		OutputTokens:      row.OutputTokens,
		CachedInputTokens: row.CachedInputTokens,
		CachedWriteTokens: row.CachedWriteTokens,
		CostUsd:           row.CostUsd,
		LlmFinishReason:   row.LlmFinishReason,
		IngestedAt:        row.IngestedAt,
	}
}

func spanDetailFromRow(w http.ResponseWriter, r *http.Request, row gatewaydb.GatewayGetSpanDetailRow) (gatewayapi.SpanDetail, bool) {
	resourceAttrs, ok := jsonValue(w, r, row.ResourceAttributes)
	if !ok {
		return gatewayapi.SpanDetail{}, false
	}
	spanAttrs, ok := jsonValue(w, r, row.SpanAttributes)
	if !ok {
		return gatewayapi.SpanDetail{}, false
	}

	return gatewayapi.SpanDetail{
		AgentName:          row.AgentName,
		CachedInputTokens:  row.CachedInputTokens,
		CachedWriteTokens:  row.CachedWriteTokens,
		CostUsd:            row.CostUsd,
		DurationMs:         float64(row.DurationNs) / float64(time.Millisecond),
		DurationNs:         row.DurationNs,
		EndTime:            row.EndTime,
		ErrorMessage:       row.ErrorMessage,
		ErrorType:          row.ErrorType,
		Id:                 row.ID,
		IngestedAt:         row.IngestedAt,
		InputTokens:        row.InputTokens,
		Kind:               row.Kind,
		LlmFinishReason:    row.LlmFinishReason,
		Model:              row.Model,
		Name:               row.Name,
		OperationName:      row.OperationName,
		OutputTokens:       row.OutputTokens,
		ParentSpanId:       hex.EncodeToString(row.ParentSpanID),
		ResourceAttributes: &resourceAttrs,
		SessionId:          row.SessionID,
		SpanAttributes:     &spanAttrs,
		SpanClass:          row.SpanClass,
		SpanId:             hex.EncodeToString(row.SpanID),
		StartTime:          row.StartTime,
		StatusCode:         row.StatusCode,
		ToolName:           row.ToolName,
		TraceId:            hex.EncodeToString(row.TraceID),
	}, true
}

func spanPayload(w http.ResponseWriter, r *http.Request, row gatewaydb.GatewayGetSpanDetailRow) (gatewayapi.SpanPayload, bool) {
	inputMessages, ok := jsonValue(w, r, row.InputMessages)
	if !ok {
		return gatewayapi.SpanPayload{}, false
	}
	outputMessages, ok := jsonValue(w, r, row.OutputMessages)
	if !ok {
		return gatewayapi.SpanPayload{}, false
	}
	toolArguments, ok := jsonValue(w, r, row.ToolArguments)
	if !ok {
		return gatewayapi.SpanPayload{}, false
	}
	toolResult, ok := jsonValue(w, r, row.ToolResult)
	if !ok {
		return gatewayapi.SpanPayload{}, false
	}
	return gatewayapi.SpanPayload{
		InputMessages:  &inputMessages,
		OutputMessages: &outputMessages,
		ToolArguments:  &toolArguments,
		ToolResult:     &toolResult,
	}, true
}

func jsonValue(w http.ResponseWriter, r *http.Request, raw []byte) (gatewayapi.JSONValue, bool) {
	if len(raw) == 0 {
		raw = []byte("null")
	}
	var out gatewayapi.JSONValue
	if !jsonBytes(w, r, raw, &out) {
		return gatewayapi.JSONValue{}, false
	}
	return out, true
}

func jsonBytes(w http.ResponseWriter, r *http.Request, raw []byte, out any) bool {
	if len(raw) == 0 {
		raw = []byte("[]")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		writeInternalError(w, r, err)
		return false
	}
	return true
}

func eventPage[T any, E any, C any](rows []T, limit int, convert func(T) E, cursor func(T) C) ([]E, string) {
	items := make([]E, 0, limit)
	var next string
	for i, row := range rows {
		if i == limit {
			next = encodeCursorPageToken(cursor(rows[limit-1]))
			break
		}
		items = append(items, convert(row))
	}
	return items, next
}

func processCursor(row gatewaydb.GatewayListProcessEventsRow) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func fileCursor(row gatewaydb.GatewayListFileEventsRow) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func networkCursor(row gatewaydb.GatewayListNetworkEventsRow) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func processEvent(row gatewaydb.GatewayListProcessEventsRow) gatewayapi.ProcessObservabilityEvent {
	return gatewayapi.ProcessObservabilityEvent{
		Id:                row.ID,
		AgentName:         row.AgentName,
		EventTime:         row.EventTime,
		IngestedAt:        row.IngestedAt,
		PodNamespace:      row.PodNamespace,
		PodName:           row.PodName,
		Process:           row.Process,
		ParentProcess:     row.ParentProcess,
		CommandInvocation: row.CommandInvocation,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
	}
}

func fileEvent(row gatewaydb.GatewayListFileEventsRow) gatewayapi.FileObservabilityEvent {
	return gatewayapi.FileObservabilityEvent{
		Id:                row.ID,
		AgentName:         row.AgentName,
		EventTime:         row.EventTime,
		IngestedAt:        row.IngestedAt,
		PodNamespace:      row.PodNamespace,
		PodName:           row.PodName,
		FilePathAccessed:  row.FilePathAccessed,
		Process:           row.Process,
		CommandInvocation: row.CommandInvocation,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
	}
}

func networkEvent(row gatewaydb.GatewayListNetworkEventsRow) gatewayapi.NetworkObservabilityEvent {
	return gatewayapi.NetworkObservabilityEvent{
		Id:                row.ID,
		AgentName:         row.AgentName,
		EventTime:         row.EventTime,
		IngestedAt:        row.IngestedAt,
		PodNamespace:      row.PodNamespace,
		PodName:           row.PodName,
		DestinationDomain: row.DestinationDomain,
		DestinationIp:     row.DestinationIp,
		DestinationPort:   row.DestinationPort,
		Protocol:          row.Protocol,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
	}
}

func processAggregatedEvent(row gatewaydb.GatewayListProcessEventsAggregatedRow) gatewayapi.ProcessObservabilityEventAggregated {
	return gatewayapi.ProcessObservabilityEventAggregated{
		AgentName:         row.AgentName,
		LastSeen:          row.LastSeen,
		Process:           row.Process,
		ParentProcess:     row.ParentProcess,
		CommandInvocation: row.CommandInvocation,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
		Occurrences:       row.Occurrences,
	}
}

func fileAggregatedEvent(row gatewaydb.GatewayListFileEventsAggregatedRow) gatewayapi.FileObservabilityEventAggregated {
	return gatewayapi.FileObservabilityEventAggregated{
		AgentName:         row.AgentName,
		LastSeen:          row.LastSeen,
		FilePathAccessed:  row.FilePathAccessed,
		Process:           row.Process,
		CommandInvocation: row.CommandInvocation,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
		Occurrences:       row.Occurrences,
	}
}

func networkAggregatedEvent(row gatewaydb.GatewayListNetworkEventsAggregatedRow) gatewayapi.NetworkObservabilityEventAggregated {
	return gatewayapi.NetworkObservabilityEventAggregated{
		AgentName:         row.AgentName,
		LastSeen:          row.LastSeen,
		DestinationDomain: row.DestinationDomain,
		DestinationIp:     row.DestinationIp,
		DestinationPort:   row.DestinationPort,
		Protocol:          row.Protocol,
		Action:            gatewayapi.ObservabilityAction(row.Action),
		Source:            row.Source,
		Occurrences:       row.Occurrences,
	}
}
