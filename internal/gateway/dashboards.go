package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/accuknox/agentz/internal/authorization"
	dashboarddb "github.com/accuknox/agentz/internal/gateway/dashboard/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const (
	dashboardPageSize   = 25
	dashboardRetention  = 30 * 24 * time.Hour
	dashboardFutureSkew = 5 * time.Minute
)

type dashboardPageCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        uuid.UUID `json:"id"`
}

type dashboardWidgetInsert struct {
	Position   int                                  `json:"position"`
	Name       string                               `json:"name"`
	Title      string                               `json:"title"`
	Kind       gatewayapi.DashboardWidgetKind       `json:"kind"`
	Mode       gatewayapi.DashboardWidgetMode       `json:"mode"`
	Width      gatewayapi.DashboardWidgetWidth      `json:"width"`
	Definition gatewayapi.DashboardWidgetDefinition `json:"definition"`
}

type dashboardStoredRecord struct {
	RecordedAt *time.Time                     `json:"recorded_at,omitempty"`
	Payload    gatewayapi.DashboardDataRecord `json:"payload"`
	ByteSize   int                            `json:"byte_size"`
}

func (s *Service) ListDashboards(w http.ResponseWriter, r *http.Request, params gatewayapi.ListDashboardsParams) {
	s.listDashboards(w, r, params.AgentName, params.PageToken)
}

func (s *Service) ListAgentDashboards(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListAgentDashboardsParams) {
	s.listDashboards(w, r, &agentName, params.PageToken)
}

func (s *Service) listDashboards(w http.ResponseWriter, r *http.Request, agentName *string, token *gatewayapi.PageTokenQuery) {
	auth, ok := requestAuthState(r.Context())
	if !ok {
		writeError(w, r, newAPIError(http.StatusUnauthorized, "unauthorized", "missing dashboard request scope", errBadRequest))
		return
	}
	agentNames := []string{}
	if agentName == nil {
		access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
		if apiErr != nil {
			writeError(w, r, apiErr)
			return
		}
		auth.workspaceID = access.workspaceID
		auth.tenantNamespace = access.namespace
		if auth.actorType == requestActorUser {
			capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
			if err != nil {
				writeInternalError(w, r, err)
				return
			}
			agentNames = usableAgentNames(nil, capabilities)
			if len(agentNames) == 0 {
				writeJSON(w, http.StatusOK, gatewayapi.ListDashboardsResponse{
					Dashboards:    []gatewayapi.DashboardSummary{},
					NextPageToken: "",
				})
				return
			}
		}
	} else if auth.tenantNamespace == "" || auth.workspaceID == "" {
		writeError(w, r, newAPIError(http.StatusUnauthorized, "unauthorized", "missing dashboard request scope", errBadRequest))
		return
	}

	cursor, cursorSet, valid := decodeCursorPageToken[dashboardPageCursor](w, r, token)
	if !valid {
		return
	}
	if cursorSet && (cursor.CreatedAt.IsZero() || cursor.ID == uuid.Nil) {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}

	args := dashboarddb.DashboardListParams{
		AgentNames:      agentNames,
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		PageSize:        dashboardPageSize + 1,
	}
	if agentName != nil {
		args.AgentName = pgtype.Text{String: *agentName, Valid: true}
	}
	if cursorSet {
		args.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		args.CursorID = pgtype.UUID{Bytes: cursor.ID, Valid: true}
	}

	rows, err := s.dashboards.DashboardList(r.Context(), args)
	if err != nil {
		writeError(w, r, mapDashboardStoreError("list dashboards", err))
		return
	}

	next := ""
	if len(rows) > dashboardPageSize {
		last := rows[dashboardPageSize-1]
		next = encodeCursorPageToken(dashboardPageCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		rows = rows[:dashboardPageSize]
	}
	items := make([]gatewayapi.DashboardSummary, len(rows))
	for i, row := range rows {
		items[i] = gatewayapi.DashboardSummary{
			AgentName:   row.AgentName,
			CreatedAt:   row.CreatedAt,
			Name:        row.Name,
			Title:       row.Title,
			WidgetCount: row.WidgetCount,
		}
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListDashboardsResponse{Dashboards: items, NextPageToken: next})
}

func (s *Service) CreateDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.CreateDashboardParams) {
	auth, quota, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	var req gatewayapi.CreateDashboardRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if err := validateDashboard(req, quota.WidgetsPerDashboard); err != nil {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_dashboard", err.Error(), err))
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, r, mapDashboardStoreError("create dashboard", err))
		return
	}
	defer tx.Rollback(r.Context())
	queries := dashboarddb.New(tx)

	count, err := queries.DashboardCountForAgent(r.Context(), dashboarddb.DashboardCountForAgentParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("count dashboards", err))
		return
	}
	if count >= int64(quota.DashboardsPerAgent) {
		writeError(w, r, newAPIError(http.StatusTooManyRequests, "dashboard_quota_exceeded", "dashboard quota exceeded", errBadRequest))
		return
	}

	created, err := queries.DashboardCreate(r.Context(), dashboarddb.DashboardCreateParams{
		TenantNamespace: auth.tenantNamespace,
		OrganizationID:  auth.organizationID,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		Name:            req.Name,
		Title:           req.Title,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("create dashboard", err))
		return
	}
	widgets := make([]dashboardWidgetInsert, len(req.Widgets))
	for i, definition := range req.Widgets {
		widgets[i] = dashboardWidgetInsert{
			Position:   i,
			Name:       definition.Name,
			Title:      definition.Title,
			Kind:       definition.Kind,
			Mode:       definition.Mode,
			Width:      definition.Width,
			Definition: definition,
		}
	}
	rawWidgets, err := json.Marshal(widgets)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard widgets: %w", err))
		return
	}
	if err := queries.DashboardCreateWidgets(r.Context(), dashboarddb.DashboardCreateWidgetsParams{
		DashboardID:     created.ID,
		TenantNamespace: auth.tenantNamespace,
		Widgets:         rawWidgets,
	}); err != nil {
		writeError(w, r, mapDashboardStoreError("create dashboard widgets", err))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, r, mapDashboardStoreError("commit dashboard", err))
		return
	}

	result, err := s.dashboard(r.Context(), auth, agentName, req.Name)
	if err != nil {
		writeError(w, r, mapDashboardStoreError("read dashboard", err))
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Service) GetDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, _ gatewayapi.GetDashboardParams) {
	auth, _, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	result, err := s.dashboard(r.Context(), auth, agentName, dashboardName)
	if err != nil {
		writeError(w, r, mapDashboardStoreError("get dashboard", err))
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) dashboard(ctx context.Context, auth requestAuth, agentName, dashboardName string) (gatewayapi.Dashboard, error) {
	stored, err := s.dashboards.DashboardGet(ctx, dashboarddb.DashboardGetParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		Name:            dashboardName,
	})
	if err != nil {
		return gatewayapi.Dashboard{}, err
	}
	rows, err := s.dashboards.DashboardListWidgets(ctx, dashboarddb.DashboardListWidgetsParams{
		TenantNamespace: auth.tenantNamespace,
		DashboardID:     stored.ID,
	})
	if err != nil {
		return gatewayapi.Dashboard{}, err
	}
	widgets := make([]gatewayapi.DashboardWidget, len(rows))
	for i, row := range rows {
		var definition gatewayapi.DashboardWidgetDefinition
		if err := json.Unmarshal(row.Definition, &definition); err != nil {
			return gatewayapi.Dashboard{}, fmt.Errorf("decode widget %q definition: %w", row.Name, err)
		}
		widgets[i] = gatewayapi.DashboardWidget{
			Columns:      definition.Columns,
			DataRevision: row.Revision,
			Kind:         definition.Kind,
			Maximum:      definition.Maximum,
			Minimum:      definition.Minimum,
			Mode:         definition.Mode,
			Name:         definition.Name,
			Series:       definition.Series,
			Thresholds:   definition.Thresholds,
			Title:        definition.Title,
			Width:        definition.Width,
		}
	}
	return gatewayapi.Dashboard{
		AgentName: stored.AgentName,
		CreatedAt: stored.CreatedAt,
		Name:      stored.Name,
		Title:     stored.Title,
		Widgets:   widgets,
	}, nil
}

func (s *Service) DeleteDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, _ gatewayapi.DeleteDashboardParams) {
	auth, _, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	_, err := s.dashboards.DashboardDelete(r.Context(), dashboarddb.DashboardDeleteParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		Name:            dashboardName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("delete dashboard", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) PublishDashboardData(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, widgetName gatewayapi.DashboardWidgetNamePath, params gatewayapi.PublishDashboardDataParams) {
	auth, quota, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	requestLimit := quota.Publish.RequestBytes.Value()
	r.Body = http.MaxBytesReader(w, r.Body, requestLimit)
	var req gatewayapi.PublishDashboardDataRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if len(req.Records) == 0 || len(req.Records) > int(quota.Publish.RecordsPerRequest) {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_dashboard_data", "record count is outside the configured limit", errBadRequest))
		return
	}

	requestJSON, err := json.Marshal(req)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode publish request: %w", err))
		return
	}
	hash := sha256.Sum256(requestJSON)
	receivedAt := time.Now().UTC()

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, r, mapDashboardStoreError("begin dashboard publish", err))
		return
	}
	defer tx.Rollback(r.Context())
	queries := dashboarddb.New(tx)

	widget, err := queries.DashboardLockWidget(r.Context(), dashboarddb.DashboardLockWidgetParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		DashboardName:   dashboardName,
		WidgetName:      widgetName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("get dashboard widget", err))
		return
	}
	if widget.Revision != req.DataRevision {
		writeError(w, r, newAPIError(http.StatusConflict, "stale_dashboard_revision", "widget definition changed; fetch the dashboard and publish against its current data_revision", errBadRequest))
		return
	}
	var definition gatewayapi.DashboardWidgetDefinition
	if err := json.Unmarshal(widget.Definition, &definition); err != nil {
		writeInternalError(w, r, fmt.Errorf("decode stored widget definition: %w", err))
		return
	}
	if err := validateDashboardRecords(definition, req.Records, receivedAt); err != nil {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_dashboard_data", err.Error(), err))
		return
	}

	replay, replayErr := queries.DashboardGetPublishReplay(r.Context(), dashboarddb.DashboardGetPublishReplayParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
		IdempotencyKey:  params.IdempotencyKey,
	})
	if replayErr == nil {
		if !bytes.Equal(replay.RequestHash, hash[:]) {
			writeError(w, r, newAPIError(http.StatusConflict, "idempotency_conflict", "idempotency key was already used with different data", errBadRequest))
			return
		}
		writeJSON(w, http.StatusOK, gatewayapi.PublishDashboardDataResponse{
			AcceptedRecords: replay.AcceptedRecords,
			ReceivedAt:      replay.ReceivedAt,
			Replayed:        true,
		})
		return
	}
	if !errors.Is(replayErr, pgx.ErrNoRows) {
		writeError(w, r, mapDashboardStoreError("read publish idempotency", replayErr))
		return
	}

	stored := make([]dashboardStoredRecord, len(req.Records))
	var acceptedBytes int64
	for i, record := range req.Records {
		var recordedAt *time.Time
		if record.RecordedAt != nil {
			at := record.RecordedAt.UTC()
			recordedAt = &at
			record.RecordedAt = nil
		}
		raw, err := json.Marshal(record)
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("encode record %d: %w", i, err))
			return
		}
		stored[i] = dashboardStoredRecord{RecordedAt: recordedAt, Payload: record, ByteSize: len(raw)}
		acceptedBytes += int64(len(raw))
	}
	storedJSON, err := json.Marshal(stored)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard records: %w", err))
		return
	}

	minute := receivedAt.Truncate(time.Minute)
	if _, err := queries.DashboardReservePublishWindow(r.Context(), dashboarddb.DashboardReservePublishWindowParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
		WindowKind:      "minute",
		WindowStart:     minute,
		Calls:           1,
		Records:         0,
		Bytes:           0,
		MaxCalls:        int64(quota.Publish.RequestsPerMinutePerAgent),
		MaxRecords:      math.MaxInt64,
		MaxBytes:        math.MaxInt64,
	}); err != nil {
		writeError(w, r, mapDashboardQuotaError("publish rate limit exceeded", err))
		return
	}
	temporalRecords := int64(0)
	if definition.Mode == gatewayapi.Temporal {
		temporalRecords = int64(len(req.Records))
	}
	if _, err := queries.DashboardReservePublishWindow(r.Context(), dashboarddb.DashboardReservePublishWindowParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
		WindowKind:      "day",
		WindowStart:     receivedAt.Truncate(24 * time.Hour),
		Calls:           0,
		Records:         temporalRecords,
		Bytes:           acceptedBytes,
		MaxCalls:        math.MaxInt64,
		MaxRecords:      quota.Publish.TemporalRecordsPerDay,
		MaxBytes:        quota.Publish.AcceptedBytesPerDay.Value(),
	}); err != nil {
		writeError(w, r, mapDashboardQuotaError("daily publish quota exceeded", err))
		return
	}

	switch definition.Mode {
	case gatewayapi.Temporal:
		if _, err := queries.DashboardReserveTemporalUsage(r.Context(), dashboarddb.DashboardReserveTemporalUsageParams{
			TenantNamespace: auth.tenantNamespace,
			Records:         int64(len(req.Records)),
			Bytes:           acceptedBytes,
			MaxRecords:      quota.Publish.RetainedTemporalRecords,
		}); err != nil {
			writeError(w, r, mapDashboardQuotaError("retained temporal record quota exceeded", err))
			return
		}
		inserted, err := queries.DashboardInsertTemporalRecords(r.Context(), dashboarddb.DashboardInsertTemporalRecordsParams{
			TenantNamespace: auth.tenantNamespace,
			WidgetRevision:  widget.Revision,
			Records:         storedJSON,
		})
		if err != nil || inserted != int64(len(stored)) {
			if err == nil {
				err = fmt.Errorf("inserted %d of %d records", inserted, len(stored))
			}
			writeError(w, r, mapDashboardStoreError("append dashboard data", err))
			return
		}
	case gatewayapi.Latest:
		oldBytes, err := queries.DashboardLatestBytes(r.Context(), dashboarddb.DashboardLatestBytesParams{
			TenantNamespace: auth.tenantNamespace,
			WidgetRevision:  widget.Revision,
		})
		if err != nil {
			writeError(w, r, mapDashboardStoreError("read latest dashboard usage", err))
			return
		}
		if _, err := queries.DashboardReserveLatestUsage(r.Context(), dashboarddb.DashboardReserveLatestUsageParams{
			TenantNamespace: auth.tenantNamespace,
			AgentName:       agentName,
			DeltaBytes:      acceptedBytes - oldBytes,
			MaxBytes:        quota.Publish.LatestBytesPerAgent.Value(),
		}); err != nil {
			writeError(w, r, mapDashboardQuotaError("latest dashboard data quota exceeded", err))
			return
		}
		if err := queries.DashboardReplaceLatestRecords(r.Context(), dashboarddb.DashboardReplaceLatestRecordsParams{
			TenantNamespace: auth.tenantNamespace,
			WidgetRevision:  widget.Revision,
			ReceivedAt:      receivedAt,
			Records:         storedJSON,
		}); err != nil {
			writeError(w, r, mapDashboardStoreError("replace latest dashboard data", err))
			return
		}
	}

	if err := queries.DashboardSavePublishReplay(r.Context(), dashboarddb.DashboardSavePublishReplayParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
		IdempotencyKey:  params.IdempotencyKey,
		RequestHash:     hash[:],
		ReceivedAt:      receivedAt,
		AcceptedRecords: int32(len(req.Records)),
	}); err != nil {
		writeError(w, r, mapDashboardStoreError("save publish idempotency", err))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, r, mapDashboardStoreError("commit dashboard publish", err))
		return
	}
	writeJSON(w, http.StatusAccepted, gatewayapi.PublishDashboardDataResponse{
		AcceptedRecords: int32(len(req.Records)),
		ReceivedAt:      receivedAt,
		Replayed:        false,
	})
}

func (s *Service) QueryDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, _ gatewayapi.QueryDashboardParams) {
	auth, quota, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	var req gatewayapi.QueryDashboardRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if !req.To.After(req.From) || req.To.Sub(req.From) > dashboardRetention {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_time_range", "time range must be positive and no longer than 30 days", errBadRequest))
		return
	}
	maxPoints := int32(240)
	if req.MaxPoints != nil {
		maxPoints = *req.MaxPoints
	}
	if maxPoints < 1 || maxPoints > quota.Query.PointsPerSeries {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_max_points", "max_points exceeds the configured limit", errBadRequest))
		return
	}

	stored, err := s.dashboards.DashboardGet(r.Context(), dashboarddb.DashboardGetParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		Name:            dashboardName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("get dashboard", err))
		return
	}
	allWidgets, err := s.dashboards.DashboardListWidgets(r.Context(), dashboarddb.DashboardListWidgetsParams{
		TenantNamespace: auth.tenantNamespace,
		DashboardID:     stored.ID,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("list dashboard widgets", err))
		return
	}
	widgets := selectedDashboardWidgets(allWidgets, req.Widgets)
	if req.Widgets != nil && len(widgets) != len(*req.Widgets) {
		writeError(w, r, newAPIError(http.StatusNotFound, "widget_not_found", "one or more requested widgets do not exist", errBadRequest))
		return
	}

	var estimatedCells int64
	for _, widget := range widgets {
		var definition gatewayapi.DashboardWidgetDefinition
		if err := json.Unmarshal(widget.Definition, &definition); err != nil {
			writeInternalError(w, r, fmt.Errorf("decode widget %q definition: %w", widget.Name, err))
			return
		}
		switch definition.Kind {
		case gatewayapi.Line, gatewayapi.Area, gatewayapi.Step:
			estimatedCells += int64(maxPoints) * int64(len(definition.Series)+1)
		case gatewayapi.Pie, gatewayapi.Bar, gatewayapi.HorizontalGroupedBar:
			estimatedCells += 13 * int64(len(definition.Series)+1)
		case gatewayapi.Scatter:
			estimatedCells += int64(maxPoints) * 5
		case gatewayapi.Gauge:
			estimatedCells++
		}
	}
	if estimatedCells > int64(quota.Query.CellsPerRequest) {
		writeError(w, r, newAPIError(http.StatusTooManyRequests, "dashboard_query_limit_exceeded", "query would exceed the per-request cell limit", errBadRequest))
		return
	}
	lease, err := s.reserveDashboardQuery(r.Context(), auth, quota, estimatedCells)
	if err != nil {
		writeError(w, r, mapDashboardQuotaError("dashboard query quota exceeded", err))
		return
	}
	defer s.releaseDashboardQuery(auth.tenantNamespace, lease)

	ctx, cancel := context.WithTimeout(r.Context(), quota.Query.Timeout.Duration)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("begin dashboard query", err))
		return
	}
	defer tx.Rollback(context.Background())
	queries := dashboarddb.New(tx)
	if _, err := queries.DashboardSetStatementTimeout(ctx, fmt.Sprintf("%dms", quota.Query.Timeout.Milliseconds())); err != nil {
		writeError(w, r, mapDashboardStoreError("set dashboard query timeout", err))
		return
	}

	results := make([]gatewayapi.DashboardWidgetQueryResult, 0, len(widgets))
	for _, widget := range widgets {
		var definition gatewayapi.DashboardWidgetDefinition
		if err := json.Unmarshal(widget.Definition, &definition); err != nil {
			writeInternalError(w, r, fmt.Errorf("decode widget %q definition: %w", widget.Name, err))
			return
		}
		if definition.Kind == gatewayapi.Table {
			continue
		}
		result := gatewayapi.DashboardWidgetQueryResult{
			WidgetName:   widget.Name,
			DataRevision: widget.Revision,
			Kind:         definition.Kind,
			Status:       gatewayapi.Ok,
			Points:       []gatewayapi.DashboardTimePoint{},
			Categories:   []gatewayapi.DashboardCategory{},
			Scatter:      []gatewayapi.DashboardScatterPoint{},
		}
		invalid, err := queries.DashboardCountInvalidRecords(ctx, dashboarddb.DashboardCountInvalidRecordsParams{
			TenantNamespace: auth.tenantNamespace,
			WidgetRevision:  widget.Revision,
			FromTime:        req.From,
			ToTime:          req.To,
		})
		if err != nil {
			writeError(w, r, mapDashboardStoreError("validate dashboard records", err))
			return
		}
		if invalid > 0 {
			result.Status = gatewayapi.InvalidData
			result.Error = dashboardDataError(invalid)
			results = append(results, result)
			continue
		}

		switch definition.Kind {
		case gatewayapi.Line, gatewayapi.Area, gatewayapi.Step:
			bucketSeconds := dashboardBucketSeconds(req.To.Sub(req.From), maxPoints)
			rows, queryErr := queries.DashboardBucketTimeSeries(ctx, dashboarddb.DashboardBucketTimeSeriesParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				BucketSeconds:   bucketSeconds,
				FromTime:        req.From,
				ToTime:          req.To,
			})
			if queryErr != nil {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.BucketSeconds = new(int64)
			*result.BucketSeconds = int64(bucketSeconds)
			result.Points = make([]gatewayapi.DashboardTimePoint, len(rows))
			for i, row := range rows {
				if err := json.Unmarshal(row.Values, &result.Points[i].Values); err != nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Points = []gatewayapi.DashboardTimePoint{}
					break
				}
				result.Points[i].At = row.Bucket
			}
			if len(result.Points) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
		case gatewayapi.Pie, gatewayapi.Bar, gatewayapi.HorizontalGroupedBar:
			categoryLimit := int32(12)
			if definition.Kind == gatewayapi.Pie {
				categoryLimit = 4
			}
			rows, queryErr := queries.DashboardAggregateCategories(ctx, dashboarddb.DashboardAggregateCategoriesParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				FromTime:        req.From,
				ToTime:          req.To,
				MaxCategories:   categoryLimit,
			})
			if queryErr != nil {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.Categories = make([]gatewayapi.DashboardCategory, len(rows))
			for i, row := range rows {
				result.Categories[i].Label = row.Label
				if err := json.Unmarshal(row.Values, &result.Categories[i].Values); err != nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Categories = []gatewayapi.DashboardCategory{}
					break
				}
			}
			if len(result.Categories) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
		case gatewayapi.Scatter:
			rows, queryErr := queries.DashboardSampleScatter(ctx, dashboarddb.DashboardSampleScatterParams{
				MaxPoints:       maxPoints,
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				FromTime:        req.From,
				ToTime:          req.To,
			})
			if queryErr != nil {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.Scatter = make([]gatewayapi.DashboardScatterPoint, len(rows))
			for i, raw := range rows {
				var record gatewayapi.DashboardDataRecord
				if err := json.Unmarshal(raw, &record); err != nil || record.Series == nil || record.X == nil || record.Y == nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Scatter = []gatewayapi.DashboardScatterPoint{}
					break
				}
				result.Scatter[i] = gatewayapi.DashboardScatterPoint{
					Series: *record.Series,
					X:      *record.X,
					Y:      *record.Y,
					Size:   record.Size,
					Label:  record.Label,
				}
			}
			if len(result.Scatter) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
		case gatewayapi.Gauge:
			rows, queryErr := queries.DashboardReadRecords(ctx, dashboarddb.DashboardReadRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				RowLimit:        1,
			})
			if queryErr != nil {
				writeError(w, r, mapDashboardStoreError("query gauge", queryErr))
				return
			}
			if len(rows) == 0 {
				result.Status = gatewayapi.Empty
				break
			}
			var record gatewayapi.DashboardDataRecord
			if err := json.Unmarshal(rows[0].Payload, &record); err != nil || record.Values == nil || len(*record.Values) != 1 {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.Value = new(float64)
			*result.Value = (*record.Values)[0]
		}
		results = append(results, result)
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, r, mapDashboardStoreError("commit dashboard query", err))
		return
	}
	response := gatewayapi.QueryDashboardResponse{From: req.From, To: req.To, Widgets: results}
	raw, err := json.Marshal(response)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard query: %w", err))
		return
	}
	if int64(len(raw)) > quota.Query.ResponseBytes.Value() {
		writeError(w, r, newAPIError(http.StatusTooManyRequests, "dashboard_response_limit_exceeded", "query response exceeds the configured byte limit", errBadRequest))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (s *Service) ListDashboardTableRows(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, widgetName gatewayapi.DashboardWidgetNamePath, params gatewayapi.ListDashboardTableRowsParams) {
	auth, quota, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	widget, err := s.dashboards.DashboardGetWidget(r.Context(), dashboarddb.DashboardGetWidgetParams{
		TenantNamespace: auth.tenantNamespace,
		WorkspaceID:     auth.workspaceID,
		AgentName:       agentName,
		DashboardName:   dashboardName,
		WidgetName:      widgetName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("get dashboard table", err))
		return
	}
	var definition gatewayapi.DashboardWidgetDefinition
	if err := json.Unmarshal(widget.Definition, &definition); err != nil {
		writeInternalError(w, r, fmt.Errorf("decode table definition: %w", err))
		return
	}
	if definition.Kind != gatewayapi.Table {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_widget_kind", "row pagination is only available for table widgets", errBadRequest))
		return
	}

	from := time.Now().UTC().Add(-24 * time.Hour)
	to := time.Now().UTC()
	if params.EventTimeAfter != nil {
		from = *params.EventTimeAfter
	}
	if params.EventTimeBefore != nil {
		to = *params.EventTimeBefore
	}
	if !to.After(from) || to.Sub(from) > dashboardRetention {
		writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_time_range", "time range must be positive and no longer than 30 days", errBadRequest))
		return
	}
	offset, valid := decodeOffsetPageToken(w, r, params.PageToken)
	if !valid {
		return
	}
	if offset > math.MaxInt32-dashboardPageSize {
		writeInvalidPageToken(w, r, errBadRequest)
		return
	}
	sortIndices := [3]int32{-1, -1, -1}
	sortAscending := [3]bool{true, true, true}
	if params.Sort != nil {
		if len(*params.Sort) > len(sortIndices) {
			writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_sort", "at most three sort columns are allowed", errBadRequest))
			return
		}
		for i, item := range *params.Sort {
			name, direction, found := strings.Cut(item, ":")
			if !found || (direction != "asc" && direction != "desc") {
				writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_sort", "sort entries must use column:asc or column:desc", errBadRequest))
				return
			}
			column := slices.IndexFunc(definition.Columns, func(column gatewayapi.DashboardTableColumn) bool {
				return column.Name == name && column.Sortable
			})
			if column < 0 {
				writeError(w, r, newAPIError(http.StatusUnprocessableEntity, "invalid_sort", fmt.Sprintf("column %q is not sortable", name), errBadRequest))
				return
			}
			sortIndices[i] = int32(column)
			sortAscending[i] = direction == "asc"
		}
	}
	estimatedCells := int64(dashboardPageSize * len(definition.Columns))
	lease, err := s.reserveDashboardQuery(r.Context(), auth, quota, estimatedCells)
	if err != nil {
		writeError(w, r, mapDashboardQuotaError("dashboard query quota exceeded", err))
		return
	}
	defer s.releaseDashboardQuery(auth.tenantNamespace, lease)

	ctx, cancel := context.WithTimeout(r.Context(), quota.Query.Timeout.Duration)
	defer cancel()
	invalid, err := s.dashboards.DashboardCountInvalidRecords(ctx, dashboarddb.DashboardCountInvalidRecordsParams{
		TenantNamespace: auth.tenantNamespace,
		WidgetRevision:  widget.Revision,
		FromTime:        from,
		ToTime:          to,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("validate dashboard table", err))
		return
	}
	if invalid > 0 {
		writeJSON(w, http.StatusOK, gatewayapi.DashboardTablePage{
			Status:        gatewayapi.InvalidData,
			Rows:          []gatewayapi.DashboardTableRow{},
			NextPageToken: "",
			Error:         dashboardDataError(invalid),
		})
		return
	}
	rows, err := s.dashboards.DashboardTableRows(ctx, dashboarddb.DashboardTableRowsParams{
		Sort0Ascending:  sortAscending[0],
		Sort0Index:      sortIndices[0],
		Sort1Ascending:  sortAscending[1],
		Sort1Index:      sortIndices[1],
		Sort2Ascending:  sortAscending[2],
		Sort2Index:      sortIndices[2],
		PageOffset:      int32(offset),
		PageSize:        dashboardPageSize + 1,
		TenantNamespace: auth.tenantNamespace,
		WidgetRevision:  widget.Revision,
		FromTime:        from,
		ToTime:          to,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("query dashboard table", err))
		return
	}
	next := ""
	if len(rows) > dashboardPageSize {
		next = encodeOffsetToken(offset + dashboardPageSize)
		rows = rows[:dashboardPageSize]
	}
	result := make([]gatewayapi.DashboardTableRow, len(rows))
	for i, row := range rows {
		var record gatewayapi.DashboardDataRecord
		if err := json.Unmarshal(row.Payload, &record); err != nil || record.Cells == nil {
			writeJSON(w, http.StatusOK, gatewayapi.DashboardTablePage{
				Status:        gatewayapi.InvalidData,
				Rows:          []gatewayapi.DashboardTableRow{},
				NextPageToken: "",
				Error:         dashboardDataError(1),
			})
			return
		}
		result[i] = gatewayapi.DashboardTableRow{At: row.At, Cells: *record.Cells}
	}
	status := gatewayapi.Ok
	if len(result) == 0 {
		status = gatewayapi.Empty
	}
	writeJSON(w, http.StatusOK, gatewayapi.DashboardTablePage{Status: status, Rows: result, NextPageToken: next})
}

func (s *Service) reserveDashboardQuery(ctx context.Context, auth requestAuth, quota agentzv1alpha1.DashboardQuota, cells int64) (uuid.UUID, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	queries := dashboarddb.New(tx)
	now := time.Now().UTC()
	subject := auth.actorID
	if strings.TrimSpace(subject) == "" {
		subject = auth.apiKeyID
	}
	if _, err := queries.DashboardReserveQueryWindow(ctx, dashboarddb.DashboardReserveQueryWindowParams{
		TenantNamespace: auth.tenantNamespace,
		SubjectID:       subject,
		WindowKind:      "minute",
		WindowStart:     now.Truncate(time.Minute),
		Calls:           1,
		Cells:           0,
		MaxCalls:        int64(quota.Query.RequestsPerMinutePerUser),
		MaxCells:        math.MaxInt64,
	}); err != nil {
		return uuid.Nil, err
	}
	if _, err := queries.DashboardReserveQueryWindow(ctx, dashboarddb.DashboardReserveQueryWindowParams{
		TenantNamespace: auth.tenantNamespace,
		SubjectID:       "*",
		WindowKind:      "hour",
		WindowStart:     now.Truncate(time.Hour),
		Calls:           0,
		Cells:           cells,
		MaxCalls:        math.MaxInt64,
		MaxCells:        quota.Query.ReturnedCellsPerHour,
	}); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	token := uuid.New()
	return s.dashboards.DashboardAcquireQueryLease(ctx, dashboarddb.DashboardAcquireQueryLeaseParams{
		TenantNamespace: auth.tenantNamespace,
		Token:           token,
		ExpiresAt:       now.Add(quota.Query.Timeout.Duration + 5*time.Second),
		MaxConcurrent:   quota.Query.ConcurrentRequests,
	})
}

func (s *Service) releaseDashboardQuery(namespace string, token uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _ = s.dashboards.DashboardReleaseQueryLease(ctx, dashboarddb.DashboardReleaseQueryLeaseParams{
		Token:           token,
		TenantNamespace: namespace,
	})
}

func dashboardDataError(count int64) *gatewayapi.DashboardWidgetError {
	return &gatewayapi.DashboardWidgetError{
		Code:               "invalid_data",
		Message:            "Stored data does not match this widget definition.",
		IssuePaths:         []string{"records"},
		InvalidRecordCount: count,
		Remediation:        "Return to the agent chat and ask the agent to delete and recreate this dashboard, then publish corrected data.",
	}
}

func dashboardBucketSeconds(period time.Duration, maxPoints int32) int32 {
	required := int64(math.Ceil(period.Seconds() / float64(maxPoints)))
	for _, interval := range [...]int64{1, 5, 10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400} {
		if required <= interval {
			return int32(interval)
		}
	}
	return 86400
}

func dashboardRequestState(w http.ResponseWriter, r *http.Request) (requestAuth, agentzv1alpha1.DashboardQuota, bool) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.tenantNamespace == "" || auth.workspaceID == "" {
		writeError(w, r, newAPIError(http.StatusUnauthorized, "unauthorized", "missing dashboard request scope", errBadRequest))
		return requestAuth{}, agentzv1alpha1.DashboardQuota{}, false
	}
	tenant, err := tenantObject(r.Context())
	if err != nil || tenant.Spec.DashboardQuota == nil {
		writeInternalError(w, r, fmt.Errorf("dashboard quota is unavailable: %w", err))
		return requestAuth{}, agentzv1alpha1.DashboardQuota{}, false
	}
	return auth, *tenant.Spec.DashboardQuota, true
}

func validateDashboard(req gatewayapi.CreateDashboardRequest, maxWidgets int32) error {
	if len(validation.IsDNS1123Label(req.Name)) != 0 {
		return errors.New("name must be a DNS label")
	}
	if utf8.RuneCountInString(req.Title) < 1 || utf8.RuneCountInString(req.Title) > 80 {
		return errors.New("title must contain 1-80 characters")
	}
	if len(req.Widgets) == 0 || len(req.Widgets) > int(maxWidgets) {
		return fmt.Errorf("dashboard must contain between 1 and %d widgets", maxWidgets)
	}
	names := make([]string, 0, len(req.Widgets))
	for i, widget := range req.Widgets {
		if slices.Contains(names, widget.Name) {
			return fmt.Errorf("widgets[%d].name %q is duplicated", i, widget.Name)
		}
		names = append(names, widget.Name)
		if err := validateDashboardWidget(widget); err != nil {
			return fmt.Errorf("widgets[%d]: %w", i, err)
		}
	}
	return nil
}

func validateDashboardWidget(widget gatewayapi.DashboardWidgetDefinition) error {
	if widget.Series == nil || widget.Columns == nil || widget.Thresholds == nil {
		return errors.New("series, columns, and thresholds must be arrays")
	}
	if len(validation.IsDNS1123Label(widget.Name)) != 0 {
		return errors.New("name must be a DNS label")
	}
	if utf8.RuneCountInString(widget.Title) < 1 || utf8.RuneCountInString(widget.Title) > 80 {
		return errors.New("title must contain 1-80 characters")
	}
	switch widget.Width {
	case gatewayapi.Full, gatewayapi.Half, gatewayapi.Third:
	default:
		return fmt.Errorf("unsupported widget width %q", widget.Width)
	}
	switch widget.Mode {
	case gatewayapi.Temporal, gatewayapi.Latest:
	default:
		return fmt.Errorf("unsupported widget mode %q", widget.Mode)
	}
	seriesNames := make([]string, 0, len(widget.Series))
	for i, series := range widget.Series {
		if len(validation.IsDNS1123Label(series.Name)) != 0 {
			return fmt.Errorf("series[%d].name must be a DNS label", i)
		}
		if slices.Contains(seriesNames, series.Name) {
			return fmt.Errorf("series[%d].name %q is duplicated", i, series.Name)
		}
		seriesNames = append(seriesNames, series.Name)
		if utf8.RuneCountInString(series.Label) < 1 || utf8.RuneCountInString(series.Label) > 80 {
			return fmt.Errorf("series[%d].label must contain 1-80 characters", i)
		}
		switch series.Aggregation {
		case gatewayapi.Sum, gatewayapi.Average, gatewayapi.Minimum, gatewayapi.Maximum, gatewayapi.Last, gatewayapi.Count:
		default:
			return fmt.Errorf("series[%d] has unsupported aggregation %q", i, series.Aggregation)
		}
	}
	columnNames := make([]string, 0, len(widget.Columns))
	for i, column := range widget.Columns {
		if len(validation.IsDNS1123Label(column.Name)) != 0 {
			return fmt.Errorf("columns[%d].name must be a DNS label", i)
		}
		if slices.Contains(columnNames, column.Name) {
			return fmt.Errorf("columns[%d].name %q is duplicated", i, column.Name)
		}
		columnNames = append(columnNames, column.Name)
		if utf8.RuneCountInString(column.Label) < 1 || utf8.RuneCountInString(column.Label) > 80 {
			return fmt.Errorf("columns[%d].label must contain 1-80 characters", i)
		}
		switch column.Type {
		case gatewayapi.DashboardTableColumnTypeText, gatewayapi.DashboardTableColumnTypeNumber, gatewayapi.DashboardTableColumnTypeBoolean, gatewayapi.DashboardTableColumnTypeDatetime:
		default:
			return fmt.Errorf("columns[%d] has unsupported type %q", i, column.Type)
		}
	}
	seriesCount := len(widget.Series)
	columnCount := len(widget.Columns)
	switch widget.Kind {
	case gatewayapi.Line, gatewayapi.Area, gatewayapi.Step:
		if widget.Mode != gatewayapi.Temporal || seriesCount == 0 || seriesCount > 5 || columnCount != 0 {
			return errors.New("time charts require temporal mode, 1-5 series, and no columns")
		}
	case gatewayapi.Pie:
		if widget.Mode != gatewayapi.Latest || seriesCount != 1 || columnCount != 0 {
			return errors.New("pie charts require latest mode, one series, and no columns")
		}
	case gatewayapi.Gauge:
		if widget.Mode != gatewayapi.Latest || seriesCount != 1 || columnCount != 0 || widget.Minimum == nil || widget.Maximum == nil || *widget.Minimum >= *widget.Maximum {
			return errors.New("gauges require latest mode, one series, no columns, and an increasing range")
		}
		previous := *widget.Minimum
		for i, threshold := range widget.Thresholds {
			if threshold.Value < *widget.Minimum || threshold.Value > *widget.Maximum || (i > 0 && threshold.Value <= previous) {
				return fmt.Errorf("thresholds[%d].value must increase within the gauge range", i)
			}
			previous = threshold.Value
			switch threshold.Tone {
			case gatewayapi.Neutral, gatewayapi.Warning, gatewayapi.Critical:
			default:
				return fmt.Errorf("thresholds[%d] has unsupported tone %q", i, threshold.Tone)
			}
		}
	case gatewayapi.Bar, gatewayapi.HorizontalGroupedBar:
		if seriesCount == 0 || seriesCount > 5 || columnCount != 0 {
			return errors.New("bar charts require 1-5 series and no columns")
		}
	case gatewayapi.Scatter:
		if seriesCount == 0 || seriesCount > 5 || columnCount != 0 {
			return errors.New("scatter plots require 1-5 series and no columns")
		}
	case gatewayapi.Table:
		if columnCount == 0 || columnCount > 12 || seriesCount != 0 {
			return errors.New("tables require 1-12 columns and no series")
		}
	default:
		return fmt.Errorf("unsupported widget kind %q", widget.Kind)
	}
	if widget.Kind != gatewayapi.Gauge && (widget.Minimum != nil || widget.Maximum != nil || len(widget.Thresholds) != 0) {
		return errors.New("only gauges may declare a range or thresholds")
	}
	return nil
}

func validateDashboardRecords(widget gatewayapi.DashboardWidgetDefinition, records []gatewayapi.DashboardDataRecord, receivedAt time.Time) error {
	if widget.Kind == gatewayapi.Gauge && len(records) != 1 {
		return errors.New("gauges require exactly one record")
	}
	for i, record := range records {
		if widget.Mode == gatewayapi.Temporal {
			if record.RecordedAt == nil {
				return fmt.Errorf("records[%d]: recorded_at is required for temporal widgets", i)
			}
			if record.RecordedAt.Before(receivedAt.Add(-dashboardRetention)) {
				return fmt.Errorf("records[%d]: recorded_at is outside the retained period", i)
			}
			if record.RecordedAt.After(receivedAt.Add(dashboardFutureSkew)) {
				return fmt.Errorf("records[%d]: recorded_at is too far in the future", i)
			}
		} else if record.RecordedAt != nil {
			return fmt.Errorf("records[%d]: recorded_at is forbidden for latest widgets", i)
		}

		var err error
		switch widget.Kind {
		case gatewayapi.Line, gatewayapi.Area, gatewayapi.Step, gatewayapi.Gauge:
			valuesMatch := record.Values != nil && len(*record.Values) == len(widget.Series)
			onlyValues := record.Category == nil &&
				record.Cells == nil &&
				record.Series == nil &&
				record.X == nil &&
				record.Y == nil &&
				record.Size == nil &&
				record.Label == nil
			if !valuesMatch || !onlyValues {
				expected := "values only"
				if widget.Mode == gatewayapi.Temporal {
					expected = "recorded_at and values only"
				}
				err = fmt.Errorf(
					"expected %s, with one value for each of %d series",
					expected,
					len(widget.Series),
				)
			}
		case gatewayapi.Pie, gatewayapi.Bar, gatewayapi.HorizontalGroupedBar:
			valuesMatch := record.Values != nil && len(*record.Values) == len(widget.Series)
			onlyCategoryValues := record.Cells == nil &&
				record.Series == nil &&
				record.X == nil &&
				record.Y == nil &&
				record.Size == nil &&
				record.Label == nil
			if record.Category == nil || !valuesMatch || !onlyCategoryValues {
				expected := "category and values only"
				if widget.Mode == gatewayapi.Temporal {
					expected = "recorded_at, category, and values only"
				}
				err = fmt.Errorf(
					"expected %s, with one value for each of %d series",
					expected,
					len(widget.Series),
				)
			} else if utf8.RuneCountInString(*record.Category) < 1 ||
				utf8.RuneCountInString(*record.Category) > 120 {
				err = errors.New("category must contain 1-120 characters")
			}
		case gatewayapi.Scatter:
			seriesMatches := record.Series != nil &&
				*record.Series >= 0 &&
				int(*record.Series) < len(widget.Series)
			onlyScatter := record.Category == nil && record.Values == nil && record.Cells == nil
			if record.X == nil || record.Y == nil || !seriesMatches || !onlyScatter {
				expected := "series, x, y, and optional size and label only"
				if widget.Mode == gatewayapi.Temporal {
					expected = "recorded_at, series, x, y, and optional size and label only"
				}
				err = fmt.Errorf("expected %s", expected)
			} else if record.Size != nil && *record.Size < 0 {
				err = errors.New("size must not be negative")
			} else if record.Label != nil && utf8.RuneCountInString(*record.Label) > 120 {
				err = errors.New("label must contain at most 120 characters")
			}
		case gatewayapi.Table:
			cellsMatch := record.Cells != nil && len(*record.Cells) == len(widget.Columns)
			onlyCells := record.Category == nil &&
				record.Values == nil &&
				record.Series == nil &&
				record.X == nil &&
				record.Y == nil &&
				record.Size == nil &&
				record.Label == nil
			if !cellsMatch || !onlyCells {
				expected := "cells only"
				if widget.Mode == gatewayapi.Temporal {
					expected = "recorded_at and cells only"
				}
				err = fmt.Errorf(
					"expected %s, with one cell for each of %d columns",
					expected,
					len(widget.Columns),
				)
			} else {
				for column, cell := range *record.Cells {
					if !dashboardCellMatches(widget.Columns[column].Type, cell) {
						err = fmt.Errorf("cell %d does not match column type %q", column, widget.Columns[column].Type)
						break
					}
					if cell.Text != nil && utf8.RuneCountInString(*cell.Text) > 1024 {
						err = fmt.Errorf("cell %d text contains more than 1024 characters", column)
						break
					}
				}
			}
		}
		if err != nil {
			return fmt.Errorf("records[%d]: %w", i, err)
		}
	}
	return nil
}

func dashboardCellMatches(columnType gatewayapi.DashboardTableColumnType, cell gatewayapi.DashboardCell) bool {
	set := 0
	if cell.Text != nil {
		set++
	}
	if cell.Number != nil {
		set++
	}
	if cell.Boolean != nil {
		set++
	}
	if cell.Datetime != nil {
		set++
	}
	if set != 1 {
		return false
	}
	switch columnType {
	case gatewayapi.DashboardTableColumnTypeText:
		return cell.Text != nil
	case gatewayapi.DashboardTableColumnTypeNumber:
		return cell.Number != nil
	case gatewayapi.DashboardTableColumnTypeBoolean:
		return cell.Boolean != nil
	case gatewayapi.DashboardTableColumnTypeDatetime:
		return cell.Datetime != nil
	default:
		return false
	}
}

func mapDashboardQuotaError(message string, err error) *apiError {
	if errors.Is(err, pgx.ErrNoRows) {
		return newAPIError(http.StatusTooManyRequests, "dashboard_quota_exceeded", message, err)
	}
	return mapDashboardStoreError("reserve dashboard quota", err)
}

func mapDashboardStoreError(action string, err error) *apiError {
	if errors.Is(err, pgx.ErrNoRows) {
		return newAPIError(http.StatusNotFound, "not_found", "dashboard resource not found", err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return newAPIError(http.StatusGatewayTimeout, "dashboard_query_timeout", "dashboard query timed out", err)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "57014" {
		return newAPIError(http.StatusGatewayTimeout, "dashboard_query_timeout", "dashboard query timed out", err)
	}
	return mapGatewayStoreError(action, err)
}

func selectedDashboardWidgets(all []dashboarddb.DashboardWidget, selected *[]string) []dashboarddb.DashboardWidget {
	if selected == nil {
		return all
	}
	wanted := *selected
	return slices.DeleteFunc(slices.Clone(all), func(widget dashboarddb.DashboardWidget) bool {
		return !slices.Contains(wanted, widget.Name)
	})
}

func (s *Service) runDashboardRetention(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		now := time.Now().UTC()
		deadline := now.Add(5 * time.Second)
		var deletedRecords, deletedBytes int64
		for time.Now().Before(deadline) {
			batchCtx, cancel := context.WithDeadline(ctx, deadline)
			removed, err := s.dashboards.DashboardDeleteExpired(batchCtx, dashboarddb.DashboardDeleteExpiredParams{
				Cutoff:    now.Add(-dashboardRetention),
				BatchSize: 1000,
			})
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					slog.ErrorContext(ctx, "delete expired dashboard records", slog.Any("err", err))
				}
				break
			}
			deletedRecords += removed.DeletedRecords
			deletedBytes += removed.DeletedBytes
			if removed.DeletedRecords < 1000 {
				break
			}
		}
		if deletedRecords > 0 {
			slog.InfoContext(ctx, "deleted expired dashboard records", slog.Int64("records", deletedRecords), slog.Int64("bytes", deletedBytes))
		}
		if err := s.dashboards.DashboardDeleteExpiredAccounting(ctx, now.Add(-dashboardRetention)); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "delete expired dashboard idempotency records", slog.Any("err", err))
		}
		if err := s.dashboards.DashboardDeleteExpiredWindows(ctx, now.Add(-48*time.Hour)); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "delete expired dashboard quota windows", slog.Any("err", err))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
