package gateway

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type appPageScope struct {
	OrganizationID string    `json:"organization_id"`
	WorkspaceID    string    `json:"workspace_id"`
	ClientID       string    `json:"client_id"`
	SessionID      string    `json:"session_id,omitempty"`
	TraceID        string    `json:"trace_id,omitempty"`
	Kind           string    `json:"kind"`
	After          time.Time `json:"after"`
	Before         time.Time `json:"before"`
}

type appSpanPageCursor struct {
	Scope     appPageScope `json:"scope"`
	StartTime time.Time    `json:"start_time"`
	ID        int64        `json:"id"`
	NonRoot   bool         `json:"non_root"`
}

type appSessionPageCursor struct {
	Scope     appPageScope `json:"scope"`
	LastSeen  time.Time    `json:"last_seen"`
	SessionID string       `json:"session_id"`
}

type appTracePageCursor struct {
	Scope     appPageScope `json:"scope"`
	StartedAt time.Time    `json:"started_at"`
	TraceID   string       `json:"trace_id"`
}

func (s *Service) appObservability(w http.ResponseWriter, r *http.Request, clientID string) (resourceAccess, bool) {
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return resourceAccess{}, false
	}
	if claims.WorkspaceID == "" {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("app telemetry requires a selected Workspace")))
		return resourceAccess{}, false
	}
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource:    "Observability",
		workspaceID: claims.WorkspaceID,
		operation:   authorization.OperationReadObservability,
	})
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return resourceAccess{}, false
	}
	if clientID == "" {
		return access, true
	}
	// Data endpoints need availability without aggregating app metadata history.
	exists, err := s.queries.GatewayLensAppExists(r.Context(), gatewaydb.GatewayLensAppExistsParams{
		OrganizationID: claims.OrganizationID,
		WorkspaceID:    claims.WorkspaceID,
		ClientID:       clientID,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get app telemetry", err))
		return access, false
	}
	if !exists {
		apiutil.WriteError(w, r, mapGatewayStoreError("get app telemetry", pgx.ErrNoRows))
		return access, false
	}
	return access, true
}

// ListLensApps lists apps with approved selections or telemetry in the active Workspace.
func (s *Service) ListLensApps(w http.ResponseWriter, r *http.Request) {
	req, ok := s.appObservability(w, r, "")
	if !ok {
		return
	}
	rows, err := s.queries.GatewayListLensApps(r.Context(), gatewaydb.GatewayListLensAppsParams{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apps := make([]gatewayapi.LensApp, 0, len(rows))
	for _, row := range rows {
		app := gatewayapi.LensApp{ClientId: row.ClientID, Name: row.Name}
		if row.UserID != "" {
			app.User = &gatewayapi.ResourceActor{
				Id:    row.UserID,
				Name:  &row.UserName,
				Email: new(openapi_types.Email(row.UserEmail)),
			}
			if row.UserImage.Valid {
				app.User.Image = &row.UserImage.String
			}
		}
		if row.AgentKind != "" {
			app.AgentKind = new(gatewayapi.LensAppAgentKind(row.AgentKind))
		}
		apps = append(apps, app)
	}
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ListLensAppsResponse{Apps: apps})
}

// ListAppSessions lists native conversation IDs using workspace observability authorization.
func (s *Service) ListAppSessions(w http.ResponseWriter, r *http.Request, clientID string, params gatewayapi.ListAppSessionsParams) {
	req, ok := s.appObservability(w, r, clientID)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	sessionID := ""
	if params.SessionId != nil {
		sessionID = *params.SessionId
	}
	cursor, set, ok := decodeCursorPageToken[appSessionPageCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	scope := appPageScope{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
		Kind:           "sessions",
	}
	if set && (cursor.Scope != scope || cursor.LastSeen.IsZero() || cursor.SessionID == "" || sessionID != "") {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	rows, err := s.queries.GatewayListAppSessions(r.Context(), gatewaydb.GatewayListAppSessionsParams{
		OrganizationID:  req.claims.OrganizationID,
		WorkspaceID:     req.workspaceID,
		ClientID:        clientID,
		SessionID:       sessionID,
		CursorSet:       set,
		CursorLastSeen:  cursor.LastSeen,
		CursorSessionID: cursor.SessionID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	sessions, next := cursorPage(
		rows,
		limit,
		func(row gatewaydb.GatewayListAppSessionsRow) gatewayapi.AppSession {
			return gatewayapi.AppSession{
				SessionId: row.SessionID,
				LastSeen:  row.LastSeen,
			}
		},
		func(row gatewaydb.GatewayListAppSessionsRow) appSessionPageCursor {
			return appSessionPageCursor{
				Scope:     scope,
				LastSeen:  row.LastSeen,
				SessionID: row.SessionID,
			}
		},
	)
	result := gatewayapi.ListAppSessionsResponse{
		Sessions:      sessions,
		NextPageToken: next,
		HasNextPage:   next != "",
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// ListAppTraces lists scoped app traces without requiring a runtime session.
func (s *Service) ListAppTraces(w http.ResponseWriter, r *http.Request, clientID string, params gatewayapi.ListAppTracesParams) {
	req, ok := s.appObservability(w, r, clientID)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	cursor, set, ok := decodeCursorPageToken[appTracePageCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	if set && (cursor.StartedAt.IsZero() || cursor.TraceID == "") {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	traceID, ok := decodeOptionalTraceCursor(w, r, cursor.TraceID, set)
	if !ok {
		return
	}
	after, before := time.Unix(0, 0).UTC(), time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
	if params.StartedAfter != nil {
		after = params.StartedAfter.UTC()
	}
	if params.StartedBefore != nil {
		before = params.StartedBefore.UTC()
	}
	if after.After(before) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request",
			"started_after must not exceed started_before", errBadRequest,
		))
		return
	}
	sessionID := ""
	if params.SessionId != nil {
		sessionID = *params.SessionId
	}
	scope := appPageScope{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
		SessionID:      sessionID,
		Kind:           "traces",
		After:          after,
		Before:         before,
	}
	if set && cursor.Scope != scope {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	rows, err := s.queries.GatewayListAppTraces(r.Context(), gatewaydb.GatewayListAppTracesParams{
		OrganizationID:  req.claims.OrganizationID,
		WorkspaceID:     req.workspaceID,
		ClientID:        clientID,
		SessionID:       sessionID,
		StartedAfter:    after,
		StartedBefore:   before,
		PageSize:        int32(limit + 1),
		CursorSet:       set,
		CursorStartedAt: cursor.StartedAt,
		CursorTraceID:   traceID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	items, next := cursorPage(rows, limit, func(row gatewaydb.GatewayListAppTracesRow) gatewayapi.AppTrace {
		item := gatewayapi.AppTrace{
			TraceId:    hex.EncodeToString(row.TraceID),
			RootSpanId: hex.EncodeToString(row.RootSpanID),
			StartedAt:  row.StartedAt,
			EndedAt:    row.EndedAt,
			UpdatedAt:  row.UpdatedAt,
			DurationNs: row.DurationNs,
			DurationMs: float64(row.DurationNs) / float64(time.Millisecond),
			SpanCount:  row.SpanCount,
			ErrorCount: row.ErrorCount,
			ToolCount:  row.ToolCount,
			ModelCount: row.ModelCount,
			StatusCode: row.StatusCode,
		}
		if row.InputTokensKnown.Bool {
			item.InputTokens = &row.InputTokens
		}
		if row.OutputTokensKnown.Bool {
			item.OutputTokens = &row.OutputTokens
		}
		if row.CachedInputTokensKnown.Bool {
			item.CachedInputTokens = &row.CachedInputTokens
		}
		if row.CachedWriteTokensKnown.Bool {
			item.CachedWriteTokens = &row.CachedWriteTokens
		}
		if row.CostUsdKnown.Bool {
			item.CostUsd = &row.CostUsd
		}
		return item
	}, func(row gatewaydb.GatewayListAppTracesRow) appTracePageCursor {
		return appTracePageCursor{
			Scope:     scope,
			StartedAt: row.StartedAt,
			TraceID:   hex.EncodeToString(row.TraceID),
		}
	})
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ListAppTracesResponse{Traces: items, NextPageToken: next})
}

// GetAppTraceChart aggregates the complete requested range independently of pagination.
func (s *Service) GetAppTraceChart(w http.ResponseWriter, r *http.Request, clientID string, params gatewayapi.GetAppTraceChartParams) {
	req, ok := s.appObservability(w, r, clientID)
	if !ok {
		return
	}
	after, before := time.Unix(0, 0).UTC(), time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
	if params.StartedAfter != nil {
		after = params.StartedAfter.UTC()
	}
	if params.StartedBefore != nil {
		before = params.StartedBefore.UTC()
	}
	if after.After(before) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest, "invalid_request",
			"started_after must not exceed started_before", errBadRequest,
		))
		return
	}
	sessionID := ""
	if params.SessionId != nil {
		sessionID = *params.SessionId
	}
	rows, err := s.queries.GatewayGetAppTraceChart(r.Context(), gatewaydb.GatewayGetAppTraceChartParams{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
		SessionID:      sessionID,
		StartedAfter:   after,
		StartedBefore:  before,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	points := make([]gatewayapi.AppTraceChartPoint, 0, len(rows))
	for _, row := range rows {
		points = append(points, gatewayapi.AppTraceChartPoint{Time: row.Time, Count: row.Count})
	}
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.AppTraceChartResponse{Points: points})
}

// ListAppSpans lists operation metadata within the authenticated app and Workspace.
func (s *Service) ListAppSpans(w http.ResponseWriter, r *http.Request, clientID string, traceID gatewayapi.TraceID, params gatewayapi.ListAppSpansParams) {
	req, ok := s.appObservability(w, r, clientID)
	if !ok {
		return
	}
	limit, ok := validLimit(w, r, params.Limit)
	if !ok {
		return
	}
	trace, ok := validTraceID(w, r, traceID)
	if !ok {
		return
	}
	cursor, set, ok := decodeCursorPageToken[appSpanPageCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	scope := appPageScope{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
		TraceID:        traceID,
		Kind:           "spans",
	}
	if set && (cursor.Scope != scope || cursor.StartTime.IsZero() || cursor.ID < 1) {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	rows, err := s.queries.GatewayListAppSpans(r.Context(), gatewaydb.GatewayListAppSpansParams{
		OrganizationID:  req.claims.OrganizationID,
		WorkspaceID:     req.workspaceID,
		ClientID:        clientID,
		TraceID:         trace,
		CursorSet:       set,
		CursorNonRoot:   cursor.NonRoot,
		CursorStartTime: cursor.StartTime,
		CursorID:        cursor.ID,
		PageSize:        int32(limit + 1),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	spans, next := cursorPage(rows, limit, func(row gatewaydb.GatewayListAppSpansRow) gatewayapi.AppSpan {
		return appSpan(row.ObserverAppSpan)
	}, func(row gatewaydb.GatewayListAppSpansRow) appSpanPageCursor {
		span := row.ObserverAppSpan
		return appSpanPageCursor{
			Scope:     scope,
			NonRoot:   span.ResourceKind != "turn",
			StartTime: span.StartTime,
			ID:        span.ID,
		}
	})
	result := gatewayapi.ListAppSpansResponse{
		Spans:         spans,
		NextPageToken: next,
		Recording:     []gatewayapi.AppOperationResponse{},
	}
	if params.IncludeRecording != nil && *params.IncludeRecording && len(spans) > 0 {
		ids := make([]int64, len(spans))
		var prompt int64
		for i, span := range spans {
			ids[i] = span.Id
			if !set && prompt == 0 && span.ResourceKind == "inference" {
				prompt = span.Id
			}
		}
		rows, err := s.queries.GatewayGetAppOperations(r.Context(), gatewaydb.GatewayGetAppOperationsParams{
			OrganizationID:    req.claims.OrganizationID,
			WorkspaceID:       req.workspaceID,
			ClientID:          clientID,
			OperationIds:      ids,
			Recording:         true,
			PromptOperationID: prompt,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if len(rows) != len(ids) {
			apiutil.WriteError(w, r, mapGatewayStoreError("get app operations", pgx.ErrNoRows))
			return
		}
		result.Recording = make([]gatewayapi.AppOperationResponse, 0, len(rows))
		for _, row := range rows {
			op, err := appOperation(row)
			if err != nil {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			result.Recording = append(result.Recording, op)
		}
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// GetAppOperation retrieves one operation and its payload using the complete viewer scope.
func (s *Service) GetAppOperation(w http.ResponseWriter, r *http.Request, clientID string, operationID int64) {
	req, ok := s.appObservability(w, r, clientID)
	if !ok {
		return
	}
	rows, err := s.queries.GatewayGetAppOperations(r.Context(), gatewaydb.GatewayGetAppOperationsParams{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
		OperationIds:   []int64{operationID},
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get app operation", err))
		return
	}
	if len(rows) == 0 {
		apiutil.WriteError(w, r, mapGatewayStoreError("get app operation", pgx.ErrNoRows))
		return
	}
	result, err := appOperation(rows[0])
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func appOperation(row gatewaydb.GatewayGetAppOperationsRow) (gatewayapi.AppOperationResponse, error) {
	result := gatewayapi.AppOperationResponse{Span: appSpan(row.ObserverAppSpan)}
	payloads := map[*string][]byte{
		&result.Payload.InputMessages:  row.InputMessages,
		&result.Payload.OutputMessages: row.OutputMessages,
		&result.Payload.ToolArguments:  row.ToolArguments,
		&result.Payload.ToolResult:     row.ToolResult,
		&result.ToolError:              row.ToolError,
	}
	var formatted bytes.Buffer
	for target, raw := range payloads {
		formatted.Reset()
		if err := json.Indent(&formatted, raw, "", "  "); err != nil {
			return gatewayapi.AppOperationResponse{}, err
		}
		*target = formatted.String()
	}
	return result, nil
}

func appSpan(row gatewaydb.ObserverAppSpan) gatewayapi.AppSpan {
	span := gatewayapi.AppSpan{
		Id:                row.ID,
		TraceId:           hex.EncodeToString(row.TraceID),
		SpanId:            hex.EncodeToString(row.SpanID),
		ParentSpanId:      hex.EncodeToString(row.ParentSpanID),
		StartTime:         row.StartTime,
		EndTime:           row.EndTime,
		IngestedAt:        row.IngestedAt,
		Name:              row.Name,
		SpanClass:         row.SpanClass,
		OperationName:     row.OperationName,
		Kind:              "SERVER",
		StatusCode:        row.StatusCode,
		ErrorType:         row.ErrorType,
		ErrorMessage:      row.ErrorMessage,
		Model:             row.Model,
		ToolName:          row.ToolName,
		SessionId:         row.SessionID,
		GrantId:           row.GrantID,
		UserId:            row.UserID,
		ResourceKind:      row.ResourceKind,
		ResourceNamespace: row.ResourceNamespace,
		ResourceName:      row.ResourceName,
		ResourceUid:       row.ResourceUid,
		TargetId:          row.TargetID,
	}
	if row.ResourceKind != "tool" {
		span.DurationNs = &row.DurationNs
		span.DurationMs = new(float64(row.DurationNs) / float64(time.Millisecond))
	}
	if row.InputTokens.Valid {
		span.InputTokens = &row.InputTokens.Int64
	}
	if row.OutputTokens.Valid {
		span.OutputTokens = &row.OutputTokens.Int64
	}
	if row.ReasoningTokens.Valid {
		span.ReasoningTokens = &row.ReasoningTokens.Int64
	}
	if row.CachedInputTokens.Valid {
		span.CachedInputTokens = &row.CachedInputTokens.Int64
	}
	if row.CachedWriteTokens.Valid {
		span.CachedWriteTokens = &row.CachedWriteTokens.Int64
	}
	if row.CostUsd.Valid {
		span.CostUsd = &row.CostUsd.Float64
	}
	return span
}

// GetAppMCPGraph counts actual native tool executions within the selected Workspace.
func (s *Service) GetAppMCPGraph(w http.ResponseWriter, r *http.Request, clientID string, params gatewayapi.GetAppMCPGraphParams) {
	// The metadata lookup below also verifies app availability.
	req, ok := s.appObservability(w, r, "")
	if !ok {
		return
	}
	appRow, err := s.queries.GatewayGetLensApp(r.Context(), gatewaydb.GatewayGetLensAppParams{
		OrganizationID: req.claims.OrganizationID,
		WorkspaceID:    req.workspaceID,
		ClientID:       clientID,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get app telemetry", err))
		return
	}
	app := gatewayapi.LensApp{ClientId: appRow.ClientID, Name: appRow.Name}
	if appRow.AgentKind != "" {
		app.AgentKind = new(gatewayapi.LensAppAgentKind(appRow.AgentKind))
	}
	after, before := params.From.UTC(), params.To.Time.UTC().Add(24*time.Hour)
	if !after.Before(before) {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "from must not exceed to", errBadRequest))
		return
	}
	sessionID := ""
	if params.SessionId != nil {
		sessionID = *params.SessionId
	}
	rows, err := s.queries.GatewayGetAppMCPGraph(r.Context(), gatewaydb.GatewayGetAppMCPGraphParams{
		OrganizationID:  req.claims.OrganizationID,
		WorkspaceID:     req.workspaceID,
		ClientID:        clientID,
		SessionID:       sessionID,
		StartTimeAfter:  after,
		StartTimeBefore: before,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	graph := gatewayapi.AppMCPGraphResponse{
		App:         app,
		Connections: []gatewayapi.MCPGraphConnection{},
		Tools:       []gatewayapi.MCPGraphTool{},
		Edges:       []gatewayapi.MCPGraphEdge{},
	}
	connections := map[string]bool{}
	for _, row := range rows {
		connectionID := "connection:" + row.ResourceUid
		if !connections[connectionID] {
			connection := gatewayapi.MCPGraphConnection{Id: connectionID, Name: row.ResourceName}
			object := &agentzv1alpha1.MCPConnection{}
			err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: row.ResourceNamespace, Name: row.ResourceName}, object)
			if err != nil && !apierrors.IsNotFound(err) {
				apiutil.WriteInternalError(w, r, err)
				return
			}
			if err == nil && string(object.UID) == row.ResourceUid {
				connection.ServerUrl = &object.Spec.Endpoint.URL
			}
			graph.Connections = append(graph.Connections, connection)
			graph.Edges = append(graph.Edges, gatewayapi.MCPGraphEdge{
				Source: "app:" + clientID,
				Target: connectionID,
				Kind:   gatewayapi.AppConnection,
			})
			connections[connectionID] = true
		}
		toolID := connectionID + ":tool:" + row.ToolName
		graph.Tools = append(graph.Tools, gatewayapi.MCPGraphTool{
			Id:           toolID,
			ConnectionId: connectionID,
			Name:         row.ToolName,
		})
		graph.Edges = append(graph.Edges, gatewayapi.MCPGraphEdge{
			Source:       connectionID,
			Target:       toolID,
			Kind:         gatewayapi.ConnectionTool,
			AvgLatencyMs: &row.AvgLatencyMs,
			SuccessCount: &row.SuccessCount,
			FailedCount:  &row.FailedCount,
			LastCalledAt: &row.LastCalledAt,
		})
	}
	apiutil.WriteJSON(w, http.StatusOK, graph)
}
