package gateway

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type guardrailEventPageCursor struct {
	Filters gatewaydb.GatewayListGuardrailEventsParams `json:"filters"`
	At      time.Time                                  `json:"at"`
	ID      string                                     `json:"id"`
}

// ListGuardrailEvents returns retained evaluations within the caller's authorized scope.
func (s *Service) ListGuardrailEvents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListGuardrailEventsParams) {
	s.serveGuardrailEvents(w, r, params, false)
}

// GetGuardrailEventChart counts evaluations over the complete selected range.
func (s *Service) GetGuardrailEventChart(w http.ResponseWriter, r *http.Request, params gatewayapi.GetGuardrailEventChartParams) {
	filters := gatewayapi.ListGuardrailEventsParams{
		From: params.From, To: params.To, TraceId: params.TraceId, SessionId: params.SessionId,
	}
	if params.Action != nil {
		filters.Action = new(gatewayapi.ListGuardrailEventsParamsAction(*params.Action))
	}
	if params.Phase != nil {
		filters.Phase = new(gatewayapi.ListGuardrailEventsParamsPhase(*params.Phase))
	}
	s.serveGuardrailEvents(w, r, filters, true)
}

func (s *Service) serveGuardrailEvents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListGuardrailEventsParams, chart bool) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Event",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   authorization.OperationListGuardrailEvents,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	limit := 25
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 100 {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "limit must be between 1 and 100", errBadRequest))
		return
	}
	cursor, set, ok := decodeCursorPageToken[guardrailEventPageCursor](w, r, params.Cursor)
	if !ok {
		return
	}
	before := time.Now().UTC()
	after := before.Add(-24 * time.Hour)
	if set {
		after, before = cursor.Filters.StartedAfter, cursor.Filters.StartedBefore
	}
	if params.From != nil {
		after = params.From.UTC()
	}
	if params.To != nil {
		before = params.To.UTC()
	}
	if !after.Before(before) || before.Sub(after) > 30*24*time.Hour {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request", "Select a time range of up to 30 days", errBadRequest,
		))
		return
	}
	filters := gatewaydb.GatewayListGuardrailEventsParams{
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
		PageSize:       int32(limit + 1),
		StartedAfter:   after, StartedBefore: before,
	}
	if params.Action != nil {
		filters.Action = string(*params.Action)
	}
	if params.Phase != nil {
		filters.Phase = string(*params.Phase)
	}
	if params.TraceId != nil {
		filters.TraceID = *params.TraceId
	}
	if params.SessionId != nil {
		filters.SessionID = *params.SessionId
	}
	if set && (cursor.Filters != filters || cursor.At.IsZero() || cursor.ID == "") {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	if filters.TraceID != "" {
		trace, err := hex.DecodeString(filters.TraceID)
		if err != nil || len(trace) != 16 {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Trace ID must contain 32 hexadecimal characters", errBadRequest))
			return
		}
	}
	if chart {
		seconds := int32(math.Ceil(before.Sub(after).Seconds() / 60))
		rows, err := s.queries.GatewayGetGuardrailEventChart(r.Context(), gatewaydb.GatewayGetGuardrailEventChartParams{
			OrganizationID: filters.OrganizationID, WorkspaceID: filters.WorkspaceID,
			StartedAfter: after, StartedBefore: before, BucketSeconds: seconds,
			Action: filters.Action, Phase: filters.Phase, TraceID: filters.TraceID, SessionID: filters.SessionID,
		})
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("count guardrail events", err))
			return
		}
		result := gatewayapi.GuardrailEventChart{
			Points: make([]gatewayapi.GuardrailEventChartPoint, 0, len(rows)), BucketSeconds: int64(seconds),
		}
		for _, row := range rows {
			result.Points = append(result.Points, gatewayapi.GuardrailEventChartPoint{Time: row.Time, Count: row.Count})
			result.Total += row.Count
		}
		apiutil.WriteJSON(w, http.StatusOK, result)
		return
	}
	query := filters
	query.CursorAt = cursor.At
	query.CursorID = cursor.ID
	rows, err := s.queries.GatewayListGuardrailEvents(r.Context(), query)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("list guardrail events", err))
		return
	}
	result := gatewayapi.ListGuardrailEventsResponse{
		Events: make([]gatewayapi.GuardrailEvent, 0, min(len(rows), limit)),
	}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		nextCursor := guardrailEventPageCursor{Filters: filters, At: last.ObserverGuardrailEvent.OccurredAt, ID: last.ObserverGuardrailEvent.ID}
		result.NextCursor = new(encodeCursorPageToken(nextCursor))
	}
	for _, row := range rows {
		event, err := guardrailEventView(row.ObserverGuardrailEvent, row.SubjectName)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		result.Events = append(result.Events, event)
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// GetGuardrailEvent returns one authorized native evaluation without captured content.
func (s *Service) GetGuardrailEvent(w http.ResponseWriter, r *http.Request, eventID string, _ gatewayapi.GetGuardrailEventParams) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Guardrail Event",
		workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation:   authorization.OperationGetGuardrailEvent,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	row, err := s.queries.GatewayGetGuardrailEvent(r.Context(), gatewaydb.GatewayGetGuardrailEventParams{
		ID:             eventID,
		OrganizationID: access.claims.OrganizationID,
		WorkspaceID:    access.workspaceID,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get guardrail event", err))
		return
	}
	event, err := guardrailEventView(row.ObserverGuardrailEvent, row.SubjectName)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, event)
}

func guardrailEventView(row gatewaydb.ObserverGuardrailEvent, subjectName string) (gatewayapi.GuardrailEvent, error) {
	var evaluation gatewayapi.GuardrailRuntimeEvaluation
	if err := json.Unmarshal(row.Evaluation, &evaluation); err != nil {
		return gatewayapi.GuardrailEvent{}, err
	}
	return gatewayapi.GuardrailEvent{
		Id:             row.ID,
		SubjectName:    subjectName,
		OrganizationId: row.OrganizationID,
		WorkspaceId:    row.WorkspaceID,
		OccurredAt:     row.OccurredAt,
		ExpiresAt:      row.ExpiresAt,
		SandboxName:    row.SandboxName,
		AgentName:      row.AgentName,
		ClientId:       row.ClientID,
		SessionId:      row.SessionID,
		Model:          row.Model,
		TraceId:        hex.EncodeToString(row.TraceID),
		SpanId:         hex.EncodeToString(row.SpanID),
		Revision:       row.Revision,
		Evaluation:     evaluation,
	}, nil
}
