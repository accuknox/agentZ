package gateway

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// guardrailEventReader caches parameter types while planning each filter combination.
// A generic plan can scan the full retained history for a single source.
type guardrailEventReader struct {
	gatewaydb.DBTX
}

func (reader guardrailEventReader) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	args = append([]any{pgx.QueryExecModeCacheDescribe}, args...)
	return reader.DBTX.Query(ctx, query, args...)
}

type guardrailEventPageCursor struct {
	Filters gatewaydb.GatewayListGuardrailEventsParams `json:"filters"`
	At      time.Time                                  `json:"at"`
	ID      string                                     `json:"id"`
}

// ListGuardrailEventSources lists available sources in the authorized scope.
func (s *Service) ListGuardrailEventSources(w http.ResponseWriter, r *http.Request, _ gatewayapi.ListGuardrailEventSourcesParams) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource: "Guardrail Event", workspaceID: r.Header.Get("X-AgentZ-Workspace-ID"),
		operation: authorization.OperationListGuardrailEvents,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	rows, err := s.queries.GatewayListGuardrailEventSources(r.Context(), gatewaydb.GatewayListGuardrailEventSourcesParams{
		OrganizationID: access.claims.OrganizationID, WorkspaceID: access.workspaceID,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("list guardrail event sources", err))
		return
	}
	result := gatewayapi.GuardrailEventSources{Agents: []string{}, Apps: []gatewayapi.LensApp{}}
	for _, row := range rows {
		if row.AgentName != "" {
			result.Agents = append(result.Agents, row.AgentName)
			continue
		}
		app := gatewayapi.LensApp{ClientId: row.ClientID, Name: row.Name}
		if row.AgentKind != "" {
			app.AgentKind = new(gatewayapi.LensAppAgentKind(row.AgentKind))
		}
		result.Apps = append(result.Apps, app)
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// ListGuardrailEvents returns retained interventions within the caller's authorized scope.
func (s *Service) ListGuardrailEvents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListGuardrailEventsParams) {
	s.serveGuardrailEvents(w, r, params, false)
}

// GetGuardrailEventChart counts interventions over the complete selected range.
func (s *Service) GetGuardrailEventChart(w http.ResponseWriter, r *http.Request, params gatewayapi.GetGuardrailEventChartParams) {
	filters := gatewayapi.ListGuardrailEventsParams{
		WorkspaceId: params.WorkspaceId, AgentName: params.AgentName, ClientId: params.ClientId,
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
	if params.WorkspaceId != nil {
		if access.workspaceID != "" && *params.WorkspaceId != access.workspaceID {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest, "invalid_request", "Workspace filter must match the request scope", errBadRequest,
			))
			return
		}
		filters.WorkspaceID = *params.WorkspaceId
	}
	if params.AgentName != nil {
		filters.AgentName = *params.AgentName
	}
	if params.ClientId != nil {
		filters.ClientID = *params.ClientId
	}
	if filters.AgentName != "" && filters.ClientID != "" {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request", "Select an agent or an external source", errBadRequest,
		))
		return
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
	queries := gatewaydb.New(guardrailEventReader{DBTX: s.db})
	if chart {
		seconds := int32(math.Ceil(before.Sub(after).Seconds() / 60))
		rows, err := queries.GatewayGetGuardrailEventChart(r.Context(), gatewaydb.GatewayGetGuardrailEventChartParams{
			OrganizationID: filters.OrganizationID, WorkspaceID: filters.WorkspaceID,
			AgentName: filters.AgentName, ClientID: filters.ClientID,
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
	rows, err := queries.GatewayListGuardrailEvents(r.Context(), query)
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
	event.TraceSource, err = s.guardrailTraceSource(r.Context(), access, eventID)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, event)
}

func (s *Service) guardrailTraceSource(ctx context.Context, access resourceAccess, eventID string) (*gatewayapi.GuardrailTraceSource, error) {
	rows, err := s.queries.GatewayFindGuardrailTraceSource(ctx, gatewaydb.GatewayFindGuardrailTraceSourceParams{
		EventID: eventID, OrganizationID: access.claims.OrganizationID,
	})
	if err != nil {
		return nil, fmt.Errorf("find guardrail trace source: %w", err)
	}
	// Independent gateway and SDK traces share a session and time interval.
	// Multiple matching model calls are ambiguous; never pick a nearby call.
	if len(rows) != 1 {
		return nil, nil
	}
	source := rows[0]
	scope := authorization.Scope{
		OrganizationID: access.claims.OrganizationID, WorkspaceID: source.WorkspaceID,
	}
	if !access.effective.Allows(scope, authorization.OperationReadObservability) {
		return nil, nil
	}
	switch {
	case source.AgentName != "":
		target := access
		target.workspaceID = source.WorkspaceID
		target.namespace = source.Namespace
		target.claims.WorkspaceID = source.WorkspaceID
		allowed, err := s.agentOperationAllowed(ctx, target, source.AgentName, authorization.OperationUseSharedAgent)
		if err != nil {
			return nil, fmt.Errorf("authorize guardrail trace source: %w", err)
		}
		if !allowed {
			return nil, nil
		}
		if source.WorkspaceType == "coding" {
			_, err := s.resolveCodingSession(ctx, target, source.AgentName, source.SessionID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil
			}
			if err != nil {
				return nil, fmt.Errorf("authorize guardrail trace session: %w", err)
			}
		}
	default:
		exists, err := s.queries.GatewayLensAppExists(ctx, gatewaydb.GatewayLensAppExistsParams{
			OrganizationID: scope.OrganizationID, WorkspaceID: source.WorkspaceID,
			ClientID: source.ClientID,
		})
		if err != nil {
			return nil, fmt.Errorf("authorize guardrail app trace: %w", err)
		}
		if !exists {
			return nil, nil
		}
	}
	return &gatewayapi.GuardrailTraceSource{
		WorkspaceId: source.WorkspaceID, AgentName: source.AgentName,
		ClientId: source.ClientID, SessionId: source.SessionID,
		TraceId: hex.EncodeToString(source.TraceID), SpanId: hex.EncodeToString(source.SpanID),
		OperationId: source.OperationID,
	}, nil
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
