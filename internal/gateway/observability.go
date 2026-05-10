package gateway

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	gatewaydb "github.com/accuknox/clawarmor/internal/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
)

// ListTraces handles GET /api/lens/trace/list.
func (s *Service) ListTraces(w http.ResponseWriter, r *http.Request, params gatewayapi.ListTracesParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, cursorSet, ok := decodeTracePageToken(w, r, params.PageToken)
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

	rows, err := s.queries.GatewayListTraces(r.Context(), gatewaydb.GatewayListTracesParams{
		AgentName:       agentName,
		StartedAfter:    startedAfter,
		StartedBefore:   startedBefore,
		CursorSet:       cursorSet,
		CursorStartedAt: cursor.StartedAt,
		CursorTraceID:   cursorTraceID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.Trace, 0, limit)
	var next string
	for i, row := range rows {
		if i == limit {
			last := rows[limit-1]
			next = encodeCursorPageToken(tracePageCursor{
				StartedAt: last.StartedAt,
				TraceID:   hex.EncodeToString(last.TraceID),
			})
			break
		}
		items = append(items, gatewayapi.Trace{
			TraceId:           hex.EncodeToString(row.TraceID),
			AgentName:         row.AgentName,
			RootSpanId:        hex.EncodeToString(row.RootSpanID),
			StartedAt:         row.StartedAt,
			EndedAt:           row.EndedAt,
			DurationNs:        row.DurationNs,
			DurationMs:        row.DurationMs,
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

	writeJSON(w, http.StatusOK, gatewayapi.ListTracesResponse{
		Traces:        items,
		NextPageToken: next,
	})
}

// ListTraceSessions handles GET /api/lens/trace/session/list.
func (s *Service) ListTraceSessions(w http.ResponseWriter, r *http.Request, params gatewayapi.ListTraceSessionsParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
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

	rows, err := s.queries.GatewayListTraceSessions(r.Context(), gatewaydb.GatewayListTraceSessionsParams{
		AgentName:       agentName,
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
			DurationMs:        row.DurationMs,
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

// ListSpans handles GET /api/lens/span/list.
func (s *Service) ListSpans(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSpansParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	traceID, ok := validTraceID(w, r, params.TraceId)
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
		AgentName:       agentName,
		TraceID:         traceID,
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

// GetSpanDetail handles GET /api/lens/span/detail.
func (s *Service) GetSpanDetail(w http.ResponseWriter, r *http.Request, params gatewayapi.GetSpanDetailParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	traceID, ok := validTraceID(w, r, params.TraceId)
	if !ok {
		return
	}
	spanID, ok := validSpanID(w, r, params.SpanId)
	if !ok {
		return
	}

	row, err := s.queries.GatewayGetSpanDetail(r.Context(), gatewaydb.GatewayGetSpanDetailParams{
		AgentName: agentName,
		TraceID:   traceID,
		SpanID:    spanID,
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

// ListProcessObservability handles GET /api/lens/observability/process/list.
func (s *Service) ListProcessObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListProcessObservabilityParams) {
	s.listProcessObservability(w, r, params)
}

// ListFileObservability handles GET /api/lens/observability/file/list.
func (s *Service) ListFileObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListFileObservabilityParams) {
	s.listFileObservability(w, r, params)
}

// ListNetworkObservability handles GET /api/lens/observability/network/list.
func (s *Service) ListNetworkObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListNetworkObservabilityParams) {
	s.listNetworkObservability(w, r, params)
}

func (s *Service) listProcessObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListProcessObservabilityParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	aggregated := params.Aggregated != nil && *params.Aggregated

	if aggregated {
		after, before, action, ok := observabilityFilters(w, r, params.EventTimeAfter, params.EventTimeBefore, params.Action)
		if !ok {
			return
		}
		if params.EventTimeAfter == nil || params.EventTimeBefore == nil {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"event_time_after and event_time_before are required when aggregated=true",
				errBadRequest,
			))
			return
		}

		cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
		if !ok {
			return
		}

		rows, err := s.queries.GatewayListProcessEventsAggregated(r.Context(), gatewaydb.GatewayListProcessEventsAggregatedParams{
			AgentName:       agentName,
			EventTimeAfter:  after,
			EventTimeBefore: before,
			Action:          action,
			CursorSet:       cursorSet,
			CursorEventTime: cursor.LastSeen,
			PageSize:        int32(limit + 1),
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}

		items, next := aggregatedEventPage(rows, limit, processAggregatedEvent, processAggregatedCursor)
		events := make([]gatewayapi.ListProcessObservabilityResponse_Events_Item, len(items))
		for i, item := range items {
			events[i].FromProcessObservabilityEventAggregated(item)
		}
		writeJSON(w, http.StatusOK, gatewayapi.ListProcessObservabilityResponse{
			Events:        events,
			NextPageToken: next,
		})
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
		AgentName:       agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, limit, processEvent, processCursor)
	events := make([]gatewayapi.ListProcessObservabilityResponse_Events_Item, len(items))
	for i, item := range items {
		events[i].FromProcessObservabilityEvent(item)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListProcessObservabilityResponse{
		Events:        events,
		NextPageToken: next,
	})
}

func (s *Service) listFileObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListFileObservabilityParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	aggregated := params.Aggregated != nil && *params.Aggregated

	if aggregated {
		after, before, action, ok := observabilityFilters(w, r, params.EventTimeAfter, params.EventTimeBefore, params.Action)
		if !ok {
			return
		}
		if params.EventTimeAfter == nil || params.EventTimeBefore == nil {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"event_time_after and event_time_before are required when aggregated=true",
				errBadRequest,
			))
			return
		}

		cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
		if !ok {
			return
		}

		rows, err := s.queries.GatewayListFileEventsAggregated(r.Context(), gatewaydb.GatewayListFileEventsAggregatedParams{
			AgentName:       agentName,
			EventTimeAfter:  after,
			EventTimeBefore: before,
			Action:          action,
			CursorSet:       cursorSet,
			CursorEventTime: cursor.LastSeen,
			PageSize:        int32(limit + 1),
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}

		items, next := aggregatedEventPage(rows, limit, fileAggregatedEvent, fileAggregatedCursor)
		events := make([]gatewayapi.ListFileObservabilityResponse_Events_Item, len(items))
		for i, item := range items {
			events[i].FromFileObservabilityEventAggregated(item)
		}
		writeJSON(w, http.StatusOK, gatewayapi.ListFileObservabilityResponse{
			Events:        events,
			NextPageToken: next,
		})
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
		AgentName:       agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, limit, fileEvent, fileCursor)
	events := make([]gatewayapi.ListFileObservabilityResponse_Events_Item, len(items))
	for i, item := range items {
		events[i].FromFileObservabilityEvent(item)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListFileObservabilityResponse{
		Events:        events,
		NextPageToken: next,
	})
}

func (s *Service) listNetworkObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListNetworkObservabilityParams) {
	agentName, ok := validAgentName(w, r, params.AgentName, "agent_name")
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}

	aggregated := params.Aggregated != nil && *params.Aggregated

	if aggregated {
		after, before, action, ok := observabilityFilters(w, r, params.EventTimeAfter, params.EventTimeBefore, params.Action)
		if !ok {
			return
		}
		if params.EventTimeAfter == nil || params.EventTimeBefore == nil {
			writeError(w, r, newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"event_time_after and event_time_before are required when aggregated=true",
				errBadRequest,
			))
			return
		}

		cursor, cursorSet, ok := decodeAggregatedEventPageToken(w, r, params.PageToken)
		if !ok {
			return
		}

		rows, err := s.queries.GatewayListNetworkEventsAggregated(r.Context(), gatewaydb.GatewayListNetworkEventsAggregatedParams{
			AgentName:       agentName,
			EventTimeAfter:  after,
			EventTimeBefore: before,
			Action:          action,
			CursorSet:       cursorSet,
			CursorEventTime: cursor.LastSeen,
			PageSize:        int32(limit + 1),
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}

		items, next := aggregatedEventPage(rows, limit, networkAggregatedEvent, networkAggregatedCursor)
		events := make([]gatewayapi.ListNetworkObservabilityResponse_Events_Item, len(items))
		for i, item := range items {
			events[i].FromNetworkObservabilityEventAggregated(item)
		}
		writeJSON(w, http.StatusOK, gatewayapi.ListNetworkObservabilityResponse{
			Events:        events,
			NextPageToken: next,
		})
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
		AgentName:       agentName,
		EventTimeAfter:  after,
		EventTimeBefore: before,
		Action:          action,
		CursorSet:       cursorSet,
		CursorEventTime: cursor.EventTime,
		CursorID:        cursor.ID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items, next := eventPage(rows, limit, networkEvent, networkCursor)
	events := make([]gatewayapi.ListNetworkObservabilityResponse_Events_Item, len(items))
	for i, item := range items {
		events[i].FromNetworkObservabilityEvent(item)
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListNetworkObservabilityResponse{
		Events:        events,
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
		DurationMs:        row.DurationMs,
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
		DurationMs:         row.DurationMs,
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
		ResourceAttributes: resourceAttrs,
		SessionId:          row.SessionID,
		SpanAttributes:     spanAttrs,
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
		InputMessages:  inputMessages,
		OutputMessages: outputMessages,
		ToolArguments:  toolArguments,
		ToolResult:     toolResult,
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

func eventPage[T any, E any](rows []T, limit int, convert func(T) E, cursor func(T) eventPageCursor) ([]E, string) {
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

func processCursor(row gatewaydb.ObserverProcessEvent) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func fileCursor(row gatewaydb.ObserverFileEvent) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func networkCursor(row gatewaydb.ObserverNetworkEvent) eventPageCursor {
	return eventPageCursor{EventTime: row.EventTime, ID: row.ID}
}

func processEvent(row gatewaydb.ObserverProcessEvent) gatewayapi.ProcessObservabilityEvent {
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

func fileEvent(row gatewaydb.ObserverFileEvent) gatewayapi.FileObservabilityEvent {
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

func networkEvent(row gatewaydb.ObserverNetworkEvent) gatewayapi.NetworkObservabilityEvent {
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

func aggregatedEventPage[T any, E any](rows []T, limit int, convert func(T) E, cursor func(T) aggregatedEventPageCursor) ([]E, string) {
	items := make([]E, 0, limit)
	var next string
	last := limit - 1
	for i, row := range rows {
		if i == limit {
			next = encodeCursorPageToken(cursor(rows[last]))
			break
		}
		items = append(items, convert(row))
	}
	return items, next
}

func processAggregatedCursor(row gatewaydb.GatewayListProcessEventsAggregatedRow) aggregatedEventPageCursor {
	return aggregatedEventPageCursor{LastSeen: row.LastSeen}
}

func fileAggregatedCursor(row gatewaydb.GatewayListFileEventsAggregatedRow) aggregatedEventPageCursor {
	return aggregatedEventPageCursor{LastSeen: row.LastSeen}
}

func networkAggregatedCursor(row gatewaydb.GatewayListNetworkEventsAggregatedRow) aggregatedEventPageCursor {
	return aggregatedEventPageCursor{LastSeen: row.LastSeen}
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
