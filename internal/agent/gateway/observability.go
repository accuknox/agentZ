package gateway

import (
	"cmp"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	gatewaydb "github.com/accuknox/clawarmor/internal/agent/gateway/db"
	gatewayapi "github.com/accuknox/clawarmor/internal/agent/gateway/openapi"
)

// GetChatHistory handles GET /api/chat-history.
func (s *Service) GetChatHistory(w http.ResponseWriter, r *http.Request, params gatewayapi.GetChatHistoryParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
	if !ok {
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	beforeSeq, ok := decodeSequencePageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	exists, err := s.queries.GatewaySessionExists(r.Context(), sessionUUID)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if !exists {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"session not found",
			errAgentNotFound,
		))
		return
	}

	rows, err := s.chatHistoryRows(r.Context(), sessionUUID, beforeSeq, limit)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	items := make([]gatewayapi.StoredSessionEvent, 0, limit)
	var next string
	for _, row := range rows {
		if len(items) == limit {
			next = encodePageToken(row.Seq)
			continue
		}

		item := gatewayapi.StoredSessionEvent{
			Seq:     row.Seq,
			EventId: row.EventID,
			EventTs: row.EventTs,
		}
		if err := json.Unmarshal(row.EventPayload, &item.Payload); err != nil {
			writeInternalError(w, r, err)
			return
		}
		items = append(items, item)
	}

	slices.SortFunc(items, func(a, b gatewayapi.StoredSessionEvent) int {
		return cmp.Compare(a.Seq, b.Seq)
	})
	writeJSON(w, http.StatusOK, gatewayapi.ChatHistoryResponse{
		SessionId:     sessionUUID,
		Events:        items,
		NextPageToken: next,
	})
}

func (s *Service) chatHistoryRows(ctx context.Context, sessionUUID uuid.UUID, beforeSeq int64, limit int) ([]gatewaydb.GatewayListRecentEventsRow, error) {
	if beforeSeq > 0 {
		pageRows, err := s.queries.GatewayListEventPage(ctx, gatewaydb.GatewayListEventPageParams{
			SessionID: sessionUUID,
			Seq:       beforeSeq,
			Limit:     int32(limit + 1),
		})
		if err != nil {
			return nil, err
		}

		rows := make([]gatewaydb.GatewayListRecentEventsRow, 0, len(pageRows))
		for _, row := range pageRows {
			rows = append(rows, gatewaydb.GatewayListRecentEventsRow(row))
		}
		return rows, nil
	}

	return s.queries.GatewayListRecentEvents(ctx, gatewaydb.GatewayListRecentEventsParams{
		SessionID: sessionUUID,
		Limit:     int32(limit + 1),
	})
}

// ListTraces handles GET /api/list-traces.
func (s *Service) ListTraces(w http.ResponseWriter, r *http.Request, params gatewayapi.ListTracesParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
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
		SessionID:       sessionUUID,
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
		items = append(items, traceFromRow(row))
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListTracesResponse{
		Traces:        items,
		NextPageToken: next,
	})
}

// ListSpans handles GET /api/list-spans.
func (s *Service) ListSpans(w http.ResponseWriter, r *http.Request, params gatewayapi.ListSpansParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
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
		SessionID:       sessionUUID,
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
		items = append(items, spanFromRow(row))
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListSpansResponse{
		Spans:         items,
		NextPageToken: next,
	})
}

// GetSpanDetail handles GET /api/get-span-detail.
func (s *Service) GetSpanDetail(w http.ResponseWriter, r *http.Request, params gatewayapi.GetSpanDetailParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
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
		SessionID: sessionUUID,
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

	writeJSON(w, http.StatusOK, gatewayapi.SpanDetailResponse{
		Span:    spanFromDetail(row),
		Payload: payload,
	})
}

// ListProcessObservability handles GET /api/list-process-observability.
func (s *Service) ListProcessObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListProcessObservabilityParams) {
	s.listProcessObservability(w, r, params)
}

// ListFileObservability handles GET /api/list-file-observability.
func (s *Service) ListFileObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListFileObservabilityParams) {
	s.listFileObservability(w, r, params)
}

// ListNetworkObservability handles GET /api/list-network-observability.
func (s *Service) ListNetworkObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListNetworkObservabilityParams) {
	s.listNetworkObservability(w, r, params)
}

func (s *Service) listProcessObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListProcessObservabilityParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
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
		SessionID:       sessionUUID,
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
	writeJSON(w, http.StatusOK, gatewayapi.ListProcessObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

func (s *Service) listFileObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListFileObservabilityParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
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
		SessionID:       sessionUUID,
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
	writeJSON(w, http.StatusOK, gatewayapi.ListFileObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

func (s *Service) listNetworkObservability(w http.ResponseWriter, r *http.Request, params gatewayapi.ListNetworkObservabilityParams) {
	_, sessionUUID, ok := validSessionID(w, r, params.SessionId.String())
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
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
		SessionID:       sessionUUID,
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
	writeJSON(w, http.StatusOK, gatewayapi.ListNetworkObservabilityResponse{
		Events:        items,
		NextPageToken: next,
	})
}

func traceFromRow(row gatewaydb.ObserverTrace) gatewayapi.Trace {
	return gatewayapi.Trace{
		TraceId:        hex.EncodeToString(row.TraceID),
		SessionId:      row.SessionID,
		RootSpanId:     hex.EncodeToString(row.RootSpanID),
		StartedAt:      row.StartedAt,
		EndedAt:        row.EndedAt,
		DurationNs:     row.DurationNs,
		SpanCount:      row.SpanCount,
		ErrorCount:     row.ErrorCount,
		ToolCount:      row.ToolCount,
		ModelCount:     row.ModelCount,
		RunId:          row.RunID,
		RequestId:      row.RequestID,
		ConversationId: row.ConversationID,
		InputTokens:    row.InputTokens,
		OutputTokens:   row.OutputTokens,
		StatusCode:     row.StatusCode,
		UpdatedAt:      row.UpdatedAt,
	}
}

func spanFromRow(row gatewaydb.ObserverTraceSpan) gatewayapi.Span {
	return gatewayapi.Span{
		Id:                 row.ID,
		SessionId:          row.SessionID,
		TraceId:            hex.EncodeToString(row.TraceID),
		SpanId:             hex.EncodeToString(row.SpanID),
		ParentSpanId:       hex.EncodeToString(row.ParentSpanID),
		StartTime:          row.StartTime,
		EndTime:            row.EndTime,
		DurationNs:         row.DurationNs,
		Name:               row.Name,
		OperationName:      row.OperationName,
		Kind:               row.Kind,
		StatusCode:         row.StatusCode,
		ErrorType:          row.ErrorType,
		ErrorMessage:       row.ErrorMessage,
		ConversationId:     row.ConversationID,
		RunId:              row.RunID,
		RequestId:          row.RequestID,
		Model:              row.Model,
		ToolName:           row.ToolName,
		InputTokens:        row.InputTokens,
		OutputTokens:       row.OutputTokens,
		CachedInputTokens:  row.CachedInputTokens,
		TimeToFirstTokenMs: row.TimeToFirstTokenMs,
		PodNamespace:       row.PodNamespace,
		PodName:            row.PodName,
		IngestedAt:         row.IngestedAt,
	}
}

func spanFromDetail(row gatewaydb.GatewayGetSpanDetailRow) gatewayapi.Span {
	return spanFromRow(gatewaydb.ObserverTraceSpan{
		ID:                 row.ID,
		SessionID:          row.SessionID,
		TraceID:            row.TraceID,
		SpanID:             row.SpanID,
		ParentSpanID:       row.ParentSpanID,
		StartTime:          row.StartTime,
		EndTime:            row.EndTime,
		DurationNs:         row.DurationNs,
		Name:               row.Name,
		OperationName:      row.OperationName,
		Kind:               row.Kind,
		StatusCode:         row.StatusCode,
		ErrorType:          row.ErrorType,
		ErrorMessage:       row.ErrorMessage,
		ConversationID:     row.ConversationID,
		RunID:              row.RunID,
		RequestID:          row.RequestID,
		Model:              row.Model,
		ToolName:           row.ToolName,
		InputTokens:        row.InputTokens,
		OutputTokens:       row.OutputTokens,
		CachedInputTokens:  row.CachedInputTokens,
		TimeToFirstTokenMs: row.TimeToFirstTokenMs,
		PodNamespace:       row.PodNamespace,
		PodName:            row.PodName,
		IngestedAt:         row.IngestedAt,
	})
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
	metadata, ok := jsonValue(w, r, row.Metadata)
	if !ok {
		return gatewayapi.SpanPayload{}, false
	}
	return gatewayapi.SpanPayload{
		InputMessages:  inputMessages,
		OutputMessages: outputMessages,
		ToolArguments:  toolArguments,
		ToolResult:     toolResult,
		Metadata:       metadata,
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
		SessionId:         row.SessionID,
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
		SessionId:         row.SessionID,
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
		SessionId:         row.SessionID,
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
