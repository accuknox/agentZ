package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	dashboardRetention       = 30 * 24 * time.Hour
	dashboardRetentionSweep  = time.Hour
	dashboardMaxBodyBytes    = 1 << 20
	dashboardMaxFields       = 32
	dashboardMaxFilters      = 32
	dashboardMaxWidgets      = 64
	dashboardMaxWriteRecords = 100
	dashboardMaxBuckets      = 300
	dashboardMaxSeries       = 10
	dashboardMaxGroups       = 100
)

var errDashboardRevisionConflict = errors.New("dashboard revision conflict")

type dashboardCursor struct {
	UpdatedAt time.Time `json:"updated_at"`
	ID        string    `json:"id"`
}

type dashboardTableCursor struct {
	ObservedAt time.Time `json:"observed_at"`
	ID         string    `json:"id"`
	SortNull   bool      `json:"sort_null"`
	SortText   string    `json:"sort_text"`
	SortNumber float64   `json:"sort_number"`
}

type storedDashboard struct {
	ID         string
	AgentName  string
	Revision   int32
	Definition []byte
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type dashboardRecordInput struct {
	ID         string             `json:"id"`
	RecordKey  *string            `json:"record_key"`
	ObservedAt time.Time          `json:"observed_at"`
	Dimensions map[string]string  `json:"dimensions"`
	Measures   map[string]float64 `json:"measures"`
}

type dashboardQueryFilter struct {
	Field  string   `json:"field"`
	Values []string `json:"values"`
}

func dashboardBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		dashboardRoute := len(parts) >= 2 && parts[0] == "api" && parts[1] == "dashboard"
		dashboardRoute = dashboardRoute || len(parts) >= 4 && parts[0] == "api" &&
			parts[1] == "agent" && parts[3] == "dashboard"
		if dashboardRoute {
			if r.ContentLength > dashboardMaxBodyBytes {
				writeError(w, r, newAPIError(
					http.StatusRequestEntityTooLarge,
					"payload_too_large",
					"dashboard request body must not exceed 1 MiB",
					errors.New("dashboard request body exceeds 1 MiB"),
				))
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, dashboardMaxBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// ListDashboards lists dashboards visible in the selected Workspace.
func (s *Service) ListDashboards(w http.ResponseWriter, r *http.Request, params gatewayapi.ListDashboardsParams) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource: "dashboard", workspaceID: params.XAgentZWorkspaceID,
		operation: authorization.OperationReadDashboards,
	})
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "read:user:"+access.claims.UserID, 1, 600, time.Minute) ||
		!s.consumeDashboardRateLimit(w, r, "read:workspace:"+access.workspaceID, 1, 3000, time.Minute) {
		return
	}
	s.listDashboards(w, r, access.workspaceID, "", params.Limit, params.PageToken)
}

// GetDashboard returns one dashboard visible in the selected Workspace.
func (s *Service) GetDashboard(w http.ResponseWriter, r *http.Request, dashboardID gatewayapi.DashboardIDPath, params gatewayapi.GetDashboardParams) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource: "dashboard", workspaceID: params.XAgentZWorkspaceID,
		operation: authorization.OperationReadDashboards,
	})
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "read:user:"+access.claims.UserID, 1, 600, time.Minute) {
		return
	}
	row, err := s.queries.GatewayGetDashboardByID(r.Context(), gatewaydb.GatewayGetDashboardByIDParams{
		WorkspaceID: access.workspaceID, ID: dashboardID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get dashboard: %w", err))
		return
	}
	s.writeStoredDashboard(w, r, storedDashboard{
		ID: row.ID, AgentName: row.AgentName, Revision: row.Revision,
		Definition: row.Definition, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time,
	}, http.StatusOK)
}

// ListAgentDashboards lists dashboards owned by the authenticated Agent.
func (s *Service) ListAgentDashboards(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListAgentDashboardsParams) {
	auth, _, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "agent-read:"+auth.actorID, 1, 600, time.Minute) {
		return
	}
	s.listDashboards(w, r, auth.workspaceID, agentName, params.Limit, params.PageToken)
}

// GetAgentDashboard returns a dashboard owned by the authenticated Agent.
func (s *Service) GetAgentDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, params gatewayapi.GetAgentDashboardParams) {
	auth, _, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "agent-read:"+auth.actorID, 1, 600, time.Minute) {
		return
	}
	row, err := s.queries.GatewayGetAgentDashboard(
		r.Context(),
		gatewaydb.GatewayGetAgentDashboardParams{
			WorkspaceID: auth.workspaceID,
			AgentName:   agentName,
			Name:        dashboardName,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get agent dashboard: %w", err))
		return
	}
	s.writeStoredDashboard(w, r, storedDashboard{
		ID:         row.ID,
		AgentName:  row.AgentName,
		Revision:   row.Revision,
		Definition: row.Definition,
		CreatedAt:  row.CreatedAt.Time,
		UpdatedAt:  row.UpdatedAt.Time,
	}, http.StatusOK)
}

// CreateAgentDashboard creates a dashboard from an interactive Agent session.
func (s *Service) CreateAgentDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.CreateAgentDashboardParams) {
	auth, kind, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok || !requireInteractiveDashboardSession(w, r, kind) {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "definition:"+auth.actorID, 1, 20, time.Hour) {
		return
	}
	var definition gatewayapi.DashboardDefinition
	if !decodeJSONBody(w, r, &definition, false) {
		return
	}
	if err := validateDashboardDefinition(definition); err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_dashboard", err.Error(), err))
		return
	}
	encoded, err := json.Marshal(definition)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard definition: %w", err))
		return
	}
	var row gatewaydb.GatewayCreateDashboardRow
	err = pgx.BeginFunc(r.Context(), s.db, func(tx pgx.Tx) error {
		q := gatewaydb.New(tx)
		row, err = q.GatewayCreateDashboard(
			r.Context(),
			gatewaydb.GatewayCreateDashboardParams{
				ID:             uuid.NewString(),
				OrganizationID: auth.organizationID,
				WorkspaceID:    auth.workspaceID,
				AgentName:      agentName,
				Name:           definition.Name,
				Definition:     encoded,
			},
		)
		if err != nil {
			return err
		}
		return createDashboardEventTrail(
			r.Context(), q, auth, row.ID, definition.Name, "create",
		)
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"a dashboard with this name already exists",
				err,
			))
			return
		}
		writeInternalError(w, r, fmt.Errorf("create dashboard: %w", err))
		return
	}
	s.writeStoredDashboard(w, r, storedDashboard{
		ID: row.ID, AgentName: row.AgentName, Revision: row.Revision,
		Definition: row.Definition, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time,
	}, http.StatusCreated)
}

// ReplaceAgentDashboard replaces a dashboard from an interactive Agent session.
func (s *Service) ReplaceAgentDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, params gatewayapi.ReplaceAgentDashboardParams) {
	auth, kind, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok || !requireInteractiveDashboardSession(w, r, kind) {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "definition:"+auth.actorID, 1, 20, time.Hour) {
		return
	}
	var req gatewayapi.ReplaceDashboardRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if err := validateDashboardDefinition(req.Definition); err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_dashboard", err.Error(), err))
		return
	}
	encoded, err := json.Marshal(req.Definition)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard definition: %w", err))
		return
	}
	var row gatewaydb.GatewayReplaceDashboardRow
	err = pgx.BeginFunc(r.Context(), s.db, func(tx pgx.Tx) error {
		q := gatewaydb.New(tx)
		row, err = q.GatewayReplaceDashboard(
			r.Context(),
			gatewaydb.GatewayReplaceDashboardParams{
				NextName:         req.Definition.Name,
				Definition:       encoded,
				WorkspaceID:      auth.workspaceID,
				AgentName:        agentName,
				Name:             dashboardName,
				ExpectedRevision: req.ExpectedRevision,
			},
		)
		if !errors.Is(err, pgx.ErrNoRows) {
			if err != nil {
				return err
			}
			return createDashboardEventTrail(
				r.Context(), q, auth, row.ID, req.Definition.Name, "replace",
			)
		}
		_, err = q.GatewayGetAgentDashboard(
			r.Context(),
			gatewaydb.GatewayGetAgentDashboardParams{
				WorkspaceID: auth.workspaceID,
				AgentName:   agentName,
				Name:        dashboardName,
			},
		)
		if err != nil {
			return err
		}
		return errDashboardRevisionConflict
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(
			http.StatusNotFound, "not_found", "dashboard not found", err,
		))
		return
	}
	if errors.Is(err, errDashboardRevisionConflict) {
		writeError(w, r, newAPIError(
			http.StatusConflict,
			"revision_conflict",
			"dashboard changed since you loaded it",
			err,
		))
		return
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"a dashboard with this name already exists",
				err,
			))
			return
		}
		writeInternalError(w, r, fmt.Errorf("replace dashboard: %w", err))
		return
	}
	s.writeStoredDashboard(w, r, storedDashboard{
		ID: row.ID, AgentName: row.AgentName, Revision: row.Revision,
		Definition: row.Definition, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time,
	}, http.StatusOK)
}

// DeleteAgentDashboard deletes a dashboard from an interactive Agent session.
func (s *Service) DeleteAgentDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, params gatewayapi.DeleteAgentDashboardParams) {
	auth, kind, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok || !requireInteractiveDashboardSession(w, r, kind) {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "definition:"+auth.actorID, 1, 20, time.Hour) {
		return
	}
	var dashboardID string
	err := pgx.BeginFunc(r.Context(), s.db, func(tx pgx.Tx) error {
		q := gatewaydb.New(tx)
		var err error
		dashboardID, err = q.GatewayDeleteDashboard(
			r.Context(),
			gatewaydb.GatewayDeleteDashboardParams{
				WorkspaceID: auth.workspaceID,
				AgentName:   agentName,
				Name:        dashboardName,
			},
		)
		if err != nil {
			return err
		}
		return createDashboardEventTrail(
			r.Context(), q, auth, dashboardID, dashboardName, "delete",
		)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("delete dashboard: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// WriteDashboardData publishes records for a dashboard owned by the Agent.
func (s *Service) WriteDashboardData(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, params gatewayapi.WriteDashboardDataParams) {
	auth, _, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok {
		return
	}
	var req gatewayapi.WriteDashboardDataRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if len(req.Records) == 0 || len(req.Records) > dashboardMaxWriteRecords {
		err := fmt.Errorf("records must contain 1 to %d items", dashboardMaxWriteRecords)
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_dashboard_data", err.Error(), err))
		return
	}
	if !s.consumeDashboardRateLimit(
		w, r, "write-calls:"+auth.actorID, 1, 120, time.Hour,
	) {
		return
	}
	if !s.consumeDashboardRateLimit(
		w, r, "write-records:"+auth.actorID, len(req.Records), 5000, time.Hour,
	) {
		return
	}
	var affected int64
	var requestErr error
	err := pgx.BeginFunc(r.Context(), s.db, func(tx pgx.Tx) error {
		q := gatewaydb.New(tx)
		row, err := q.GatewayGetAgentDashboard(
			r.Context(),
			gatewaydb.GatewayGetAgentDashboardParams{
				WorkspaceID: auth.workspaceID,
				AgentName:   agentName,
				Name:        dashboardName,
			},
		)
		if err != nil {
			return err
		}
		var definition gatewayapi.DashboardDefinition
		err = json.Unmarshal(row.Definition, &definition)
		if err != nil {
			return fmt.Errorf("decode stored dashboard definition: %w", err)
		}
		var encoded []byte
		encoded, requestErr = encodeDashboardRecords(definition, req)
		if requestErr != nil {
			return requestErr
		}
		affected, err = q.GatewayWriteDashboardRecords(
			r.Context(),
			gatewaydb.GatewayWriteDashboardRecordsParams{
				DashboardID: row.ID,
				WorkspaceID: auth.workspaceID,
				SessionID:   params.XAgentZSessionID,
				Records:     encoded,
				Upsert:      req.Action == gatewayapi.Upsert,
			},
		)
		if err != nil {
			return fmt.Errorf("write dashboard records: %w", err)
		}
		return createDashboardEventTrail(
			r.Context(), q, auth, row.ID, dashboardName, "write-data",
		)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return
	}
	if requestErr != nil {
		writeError(w, r, newAPIError(
			http.StatusBadRequest, "invalid_dashboard_data", requestErr.Error(), requestErr,
		))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("publish dashboard data: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.DashboardDataMutationResponse{Affected: affected})
}

// DeleteDashboardData removes keyed records from an Agent dashboard.
func (s *Service) DeleteDashboardData(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, dashboardName gatewayapi.DashboardNamePath, params gatewayapi.DeleteDashboardDataParams) {
	auth, kind, ok := s.dashboardAgentSession(w, r, agentName, params.XAgentZSessionID)
	if !ok || !requireInteractiveDashboardSession(w, r, kind) {
		return
	}
	var req gatewayapi.DeleteDashboardDataRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	allowed := s.consumeDashboardRateLimit(
		w, r, "delete-data:"+auth.actorID, len(req.RecordKeys), 1000, time.Hour,
	)
	if !allowed {
		return
	}
	var affected int64
	err := pgx.BeginFunc(r.Context(), s.db, func(tx pgx.Tx) error {
		q := gatewaydb.New(tx)
		row, err := q.GatewayGetAgentDashboard(
			r.Context(),
			gatewaydb.GatewayGetAgentDashboardParams{
				WorkspaceID: auth.workspaceID,
				AgentName:   agentName,
				Name:        dashboardName,
			},
		)
		if err != nil {
			return err
		}
		affected, err = q.GatewayDeleteDashboardRecords(
			r.Context(),
			gatewaydb.GatewayDeleteDashboardRecordsParams{
				DashboardID: row.ID,
				WorkspaceID: auth.workspaceID,
				RecordKeys:  req.RecordKeys,
			},
		)
		if err != nil {
			return fmt.Errorf("delete dashboard records: %w", err)
		}
		return createDashboardEventTrail(
			r.Context(), q, auth, row.ID, dashboardName, "delete-data",
		)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("delete dashboard data: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.DashboardDataMutationResponse{Affected: affected})
}

func createDashboardEventTrail(ctx context.Context, q gatewaydb.Querier, auth requestAuth, dashboardID, dashboardName, action string) error {
	fields, err := json.Marshal([]gatewayapi.EventTrailField{{
		Field: gatewayapi.EventTrailFieldName, Value: dashboardName,
	}})
	if err != nil {
		return fmt.Errorf("encode dashboard event trail summary: %w", err)
	}
	_, err = q.GatewayCreateEventTrailEvent(ctx, gatewaydb.GatewayCreateEventTrailEventParams{
		ID: "event-trail-" + uuid.NewString(), OrganizationID: auth.organizationID,
		WorkspaceID: pgtype.Text{String: auth.workspaceID, Valid: true},
		ActorType:   gatewaydb.EventTrailActorSystem,
		TargetType:  gatewaydb.EventTrailTargetDashboard, TargetID: dashboardID,
		Category: "dashboard", Action: "dashboard." + action,
		Result: gatewaydb.EventTrailResultSucceeded, After: fields,
	})
	if err != nil {
		return fmt.Errorf("create dashboard event trail event: %w", err)
	}
	return nil
}

// QueryDashboardWidget returns data for one dashboard widget.
func (s *Service) QueryDashboardWidget(w http.ResponseWriter, r *http.Request, dashboardID gatewayapi.DashboardIDPath, widgetID gatewayapi.DashboardWidgetIDPath, params gatewayapi.QueryDashboardWidgetParams) {
	row, definition, userID, ok := s.readDashboardForUser(w, r, dashboardID, params.XAgentZWorkspaceID)
	if !ok {
		return
	}
	if !s.consumeDashboardRateLimit(
		w, r, "query:user:"+userID, 1, 600, time.Minute,
	) {
		return
	}
	if !s.consumeDashboardRateLimit(
		w, r, "query:workspace:"+params.XAgentZWorkspaceID, 1, 3000,
		time.Minute,
	) {
		return
	}
	var req gatewayapi.DashboardQueryRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if err := validateDashboardTimeRange(req.TimeRange); err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_time_range", err.Error(), err))
		return
	}
	var widget *gatewayapi.DashboardWidget
	for index := range definition.Widgets {
		if definition.Widgets[index].Id == widgetID {
			widget = &definition.Widgets[index]
			break
		}
	}
	if widget == nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"dashboard widget not found",
			pgx.ErrNoRows,
		))
		return
	}
	filters, err := dashboardQueryFilters(definition, req.Filters)
	if err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_dashboard_filter", err.Error(), err))
		return
	}
	tableCursor, cursorSet, ok := decodeCursorPageToken[dashboardTableCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	if cursorSet && widget.Kind != gatewayapi.DashboardWidgetTable {
		writeInvalidPageToken(w, r, errors.New("widget does not return paginated rows"))
		return
	}
	if cursorSet && (tableCursor.ObservedAt.IsZero() || tableCursor.ID == "") {
		writeInvalidPageToken(w, r, errors.New("invalid dashboard table cursor"))
		return
	}
	pageSize := int32(50)
	if params.Limit != nil {
		pageSize = *params.Limit
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin dashboard query: %w", err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	queries := gatewaydb.New(tx)
	if err = queries.GatewaySetDashboardQueryTimeout(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("set dashboard query timeout: %w", err))
		return
	}
	_, err = queries.GatewayAcquireDashboardQuerySlot(r.Context(), params.XAgentZWorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Retry-After", "1")
		writeError(w, r, newAPIError(
			http.StatusTooManyRequests,
			"query_busy",
			"all dashboard query slots are busy",
			err,
		))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("acquire dashboard query slot: %w", err))
		return
	}

	result := gatewayapi.DashboardWidgetResult{
		WidgetId: widget.Id, Kind: widget.Kind, Revision: row.Revision, GeneratedAt: time.Now(),
		Series: []gatewayapi.DashboardSeries{}, Points: []gatewayapi.DashboardPoint{},
		Columns: []string{}, Rows: []gatewayapi.DashboardTableRow{}, NextPageToken: "",
	}
	switch widget.Kind {
	case gatewayapi.DashboardWidgetMetric:
		err = queryDashboardMetric(
			r.Context(), queries, params.XAgentZWorkspaceID, row.ID, *widget,
			req.TimeRange, filters, &result,
		)
	case gatewayapi.DashboardWidgetLine, gatewayapi.DashboardWidgetArea, gatewayapi.DashboardWidgetBar:
		err = queryDashboardTimeSeries(
			r.Context(), queries, params.XAgentZWorkspaceID, row.ID, *widget,
			req.TimeRange, filters, &result,
		)
	case gatewayapi.DashboardWidgetDonut:
		err = queryDashboardDonut(
			r.Context(), queries, params.XAgentZWorkspaceID, row.ID, *widget,
			req.TimeRange, filters, &result,
		)
	case gatewayapi.DashboardWidgetTable:
		err = queryDashboardTable(
			r.Context(), queries, params.XAgentZWorkspaceID, row.ID, definition,
			*widget, req.TimeRange, filters, tableCursor, cursorSet, pageSize,
			&result,
		)
	default:
		err = fmt.Errorf("unsupported dashboard widget kind %q", widget.Kind)
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("query dashboard widget %q: %w", widget.Id, err))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit dashboard query: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ListDashboardFilterOptions returns bounded values for one categorical filter.
func (s *Service) ListDashboardFilterOptions(w http.ResponseWriter, r *http.Request, dashboardID gatewayapi.DashboardIDPath, filterID gatewayapi.DashboardFilterIDPath, params gatewayapi.ListDashboardFilterOptionsParams) {
	row, definition, userID, ok := s.readDashboardForUser(w, r, dashboardID, params.XAgentZWorkspaceID)
	if !ok {
		return
	}
	if !s.consumeDashboardRateLimit(w, r, "filter:user:"+userID, 1, 120, time.Minute) {
		return
	}
	if !s.consumeDashboardRateLimit(
		w, r, "filter:workspace:"+params.XAgentZWorkspaceID, 1, 3000,
		time.Minute,
	) {
		return
	}
	var selected *gatewayapi.DashboardFilter
	for index := range definition.Filters {
		if definition.Filters[index].Id == filterID {
			selected = &definition.Filters[index]
			break
		}
	}
	if selected == nil {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"not_found",
			"dashboard filter not found",
			pgx.ErrNoRows,
		))
		return
	}
	var timeRange gatewayapi.DashboardTimeRange
	if !decodeJSONBody(w, r, &timeRange, false) {
		return
	}
	if err := validateDashboardTimeRange(timeRange); err != nil {
		writeError(w, r, newAPIError(http.StatusBadRequest, "invalid_time_range", err.Error(), err))
		return
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("begin dashboard filter query: %w", err))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	queries := gatewaydb.New(tx)
	if err = queries.GatewaySetDashboardQueryTimeout(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("set dashboard filter timeout: %w", err))
		return
	}
	_, err = queries.GatewayAcquireDashboardQuerySlot(r.Context(), params.XAgentZWorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Retry-After", "1")
		writeError(w, r, newAPIError(
			http.StatusTooManyRequests,
			"query_busy",
			"all dashboard query slots are busy",
			err,
		))
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("acquire dashboard filter query slot: %w", err))
		return
	}
	values, err := queries.GatewayListDashboardFilterOptions(
		r.Context(),
		gatewaydb.GatewayListDashboardFilterOptionsParams{
			Field:          selected.Field,
			WorkspaceID:    params.XAgentZWorkspaceID,
			DashboardID:    row.ID,
			ObservedAfter:  pgtype.Timestamptz{Time: timeRange.From, Valid: true},
			ObservedBefore: pgtype.Timestamptz{Time: timeRange.To, Valid: true},
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list dashboard filter options: %w", err))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeInternalError(w, r, fmt.Errorf("commit dashboard filter query: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.DashboardFilterOptions{
		FilterId: filterID,
		Revision: row.Revision,
		Values:   values,
	})
}

func (s *Service) readDashboardForUser(w http.ResponseWriter, r *http.Request, dashboardID, workspaceID string) (gatewaydb.GatewayGetDashboardByIDRow, gatewayapi.DashboardDefinition, string, bool) {
	access, apiErr := s.resolveResourceAccess(r.Context(), resourceAccessRequest{
		resource: "dashboard", workspaceID: workspaceID, operation: authorization.OperationReadDashboards,
	})
	if apiErr != nil {
		writeError(w, r, apiErr)
		return gatewaydb.GatewayGetDashboardByIDRow{}, gatewayapi.DashboardDefinition{}, "", false
	}
	row, err := s.queries.GatewayGetDashboardByID(r.Context(), gatewaydb.GatewayGetDashboardByIDParams{
		WorkspaceID: workspaceID, ID: dashboardID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(http.StatusNotFound, "not_found", "dashboard not found", err))
		return gatewaydb.GatewayGetDashboardByIDRow{}, gatewayapi.DashboardDefinition{}, "", false
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get dashboard: %w", err))
		return gatewaydb.GatewayGetDashboardByIDRow{}, gatewayapi.DashboardDefinition{}, "", false
	}
	var definition gatewayapi.DashboardDefinition
	if err := json.Unmarshal(row.Definition, &definition); err != nil {
		writeInternalError(w, r, fmt.Errorf("decode dashboard definition: %w", err))
		return gatewaydb.GatewayGetDashboardByIDRow{}, gatewayapi.DashboardDefinition{}, "", false
	}
	return row, definition, access.claims.UserID, true
}

func validateDashboardTimeRange(timeRange gatewayapi.DashboardTimeRange) error {
	if !timeRange.From.Before(timeRange.To) {
		return errors.New("time_range.from must be earlier than time_range.to")
	}
	if timeRange.To.Sub(timeRange.From) > dashboardRetention {
		return errors.New("time_range must not span more than 30 days")
	}
	if timeRange.To.After(time.Now().Add(5 * time.Minute)) {
		return errors.New("time_range.to must not be more than 5 minutes in the future")
	}
	return nil
}

func dashboardQueryFilters(definition gatewayapi.DashboardDefinition, filters []gatewayapi.DashboardQueryFilter) ([]byte, error) {
	declared := make(map[string]gatewayapi.DashboardFilter, len(definition.Filters))
	for _, filter := range definition.Filters {
		declared[filter.Id] = filter
	}
	seen := make(map[string]struct{}, len(filters))
	selected := make([]dashboardQueryFilter, 0, len(filters))
	for _, filter := range filters {
		declaredFilter, exists := declared[filter.FilterId]
		if !exists {
			return nil, fmt.Errorf("unknown filter %q", filter.FilterId)
		}
		if _, duplicate := seen[filter.FilterId]; duplicate {
			return nil, fmt.Errorf("filter %q is duplicated", filter.FilterId)
		}
		seen[filter.FilterId] = struct{}{}
		if len(filter.Values) == 0 {
			continue
		}
		if !declaredFilter.Multiple && len(filter.Values) > 1 {
			return nil, fmt.Errorf("filter %q accepts one value", filter.FilterId)
		}
		selected = append(selected, dashboardQueryFilter{
			Field: declaredFilter.Field, Values: filter.Values,
		})
	}
	encoded, err := json.Marshal(selected)
	if err != nil {
		return nil, fmt.Errorf("encode dashboard filters: %w", err)
	}
	return encoded, nil
}

func queryDashboardMetric(ctx context.Context, queries gatewaydb.Querier, workspaceID, dashboardID string, widget gatewayapi.DashboardWidget, timeRange gatewayapi.DashboardTimeRange, filters []byte, result *gatewayapi.DashboardWidgetResult) error {
	total, err := queries.GatewayQueryDashboardMetric(ctx, gatewaydb.GatewayQueryDashboardMetricParams{
		Aggregation:    string(*widget.Aggregation),
		Measure:        *widget.Measure,
		WorkspaceID:    workspaceID,
		DashboardID:    dashboardID,
		ObservedAfter:  pgtype.Timestamptz{Time: timeRange.From, Valid: true},
		ObservedBefore: pgtype.Timestamptz{Time: timeRange.To, Valid: true},
		Filters:        filters,
	})
	if err != nil {
		return err
	}
	result.Total = &total
	return nil
}

func queryDashboardTimeSeries(ctx context.Context, queries gatewaydb.Querier, workspaceID, dashboardID string, widget gatewayapi.DashboardWidget, timeRange gatewayapi.DashboardTimeRange, filters []byte, result *gatewayapi.DashboardWidgetResult) error {
	bucketSeconds := int32((6 * time.Hour) / time.Second)
	duration := timeRange.To.Sub(timeRange.From)
	switch {
	case duration <= 6*time.Hour:
		bucketSeconds = int32(time.Minute / time.Second)
	case duration <= 24*time.Hour:
		bucketSeconds = int32((5 * time.Minute) / time.Second)
	case duration <= 3*24*time.Hour:
		bucketSeconds = int32((15 * time.Minute) / time.Second)
	case duration <= 14*24*time.Hour:
		bucketSeconds = int32(time.Hour / time.Second)
	}
	groupBy := ""
	if widget.GroupBy != nil {
		groupBy = *widget.GroupBy
	}
	rows, err := queries.GatewayQueryDashboardTimeSeries(
		ctx,
		gatewaydb.GatewayQueryDashboardTimeSeriesParams{
			BucketSeconds:  bucketSeconds,
			Aggregation:    string(*widget.Aggregation),
			RowLimit:       dashboardMaxBuckets * dashboardMaxSeries,
			Grouped:        widget.GroupBy != nil,
			GroupBy:        groupBy,
			Measure:        *widget.Measure,
			WorkspaceID:    workspaceID,
			DashboardID:    dashboardID,
			ObservedAfter:  pgtype.Timestamptz{Time: timeRange.From, Valid: true},
			ObservedBefore: pgtype.Timestamptz{Time: timeRange.To, Valid: true},
			Filters:        filters,
			SeriesLimit:    dashboardMaxSeries,
		},
	)
	if err != nil {
		return err
	}
	buckets := make(map[time.Time]map[string]float64)
	labels := make(map[string]struct{})
	for _, row := range rows {
		values := buckets[row.Bucket]
		if values == nil {
			values = make(map[string]float64)
			buckets[row.Bucket] = values
		}
		values[row.Label] = row.Value
		labels[row.Label] = struct{}{}
	}
	seriesLabels := slices.Sorted(maps.Keys(labels))
	for index, label := range seriesLabels {
		result.Series = append(result.Series, gatewayapi.DashboardSeries{
			Key:   fmt.Sprintf("s%d", index),
			Label: label,
		})
	}
	ordered := make([]time.Time, 0, len(buckets))
	for at := range buckets {
		ordered = append(ordered, at)
	}
	slices.SortFunc(ordered, time.Time.Compare)
	for _, at := range ordered {
		values := make([]float64, len(seriesLabels))
		for index, label := range seriesLabels {
			values[index] = buckets[at][label]
		}
		result.Points = append(result.Points, gatewayapi.DashboardPoint{
			Key:    at.Format(time.RFC3339),
			Label:  at.Format(time.RFC3339),
			Values: values,
		})
	}
	return nil
}

func queryDashboardDonut(ctx context.Context, queries gatewaydb.Querier, workspaceID, dashboardID string, widget gatewayapi.DashboardWidget, timeRange gatewayapi.DashboardTimeRange, filters []byte, result *gatewayapi.DashboardWidgetResult) error {
	limit := int32(dashboardMaxGroups)
	if widget.Limit != nil {
		limit = min(limit, *widget.Limit)
	}
	rows, err := queries.GatewayQueryDashboardDonut(ctx, gatewaydb.GatewayQueryDashboardDonutParams{
		GroupBy:        *widget.GroupBy,
		Aggregation:    string(*widget.Aggregation),
		Measure:        *widget.Measure,
		WorkspaceID:    workspaceID,
		DashboardID:    dashboardID,
		ObservedAfter:  pgtype.Timestamptz{Time: timeRange.From, Valid: true},
		ObservedBefore: pgtype.Timestamptz{Time: timeRange.To, Valid: true},
		Filters:        filters,
		RowLimit:       limit,
	})
	if err != nil {
		return err
	}
	result.Series = append(result.Series, gatewayapi.DashboardSeries{Key: "s0", Label: widget.Title})
	for _, row := range rows {
		result.Points = append(result.Points, gatewayapi.DashboardPoint{
			Key:    row.Label,
			Label:  row.Label,
			Values: []float64{row.Value},
		})
	}
	return nil
}

func queryDashboardTable(ctx context.Context, queries gatewaydb.Querier, workspaceID, dashboardID string, definition gatewayapi.DashboardDefinition, widget gatewayapi.DashboardWidget, timeRange gatewayapi.DashboardTimeRange, filters []byte, cursor dashboardTableCursor, cursorSet bool, pageSize int32, result *gatewayapi.DashboardWidgetResult) error {
	dimensionFields := make([]string, 0, len(definition.Dimensions))
	sortDimension := false
	for _, dimension := range definition.Dimensions {
		dimensionFields = append(dimensionFields, dimension.Name)
		sortDimension = sortDimension || widget.SortBy != nil && dimension.Name == *widget.SortBy
	}
	sortBy := ""
	if widget.SortBy != nil {
		sortBy = *widget.SortBy
	}
	rows, err := queries.GatewayQueryDashboardTable(ctx, gatewaydb.GatewayQueryDashboardTableParams{
		DimensionFields: dimensionFields,
		Columns:         *widget.Columns,
		WorkspaceID:     workspaceID,
		DashboardID:     dashboardID,
		ObservedAfter:   pgtype.Timestamptz{Time: timeRange.From, Valid: true},
		ObservedBefore:  pgtype.Timestamptz{Time: timeRange.To, Valid: true},
		Filters:         filters,
		SortSet:         widget.SortBy != nil,
		SortDimension:   sortDimension,
		SortDescending: widget.SortDirection != nil &&
			*widget.SortDirection == gatewayapi.DashboardSortDirectionDesc,
		SortBy:           sortBy,
		CursorSet:        cursorSet,
		CursorObservedAt: cursor.ObservedAt,
		CursorID:         cursor.ID,
		CursorSortNull:   cursor.SortNull,
		CursorSortText:   cursor.SortText,
		CursorSortNumber: cursor.SortNumber,
		RowLimit:         pageSize + 1,
	})
	if err != nil {
		return err
	}
	if len(rows) > int(pageSize) {
		last := rows[pageSize-1]
		result.NextPageToken = encodeCursorPageToken(dashboardTableCursor{
			ObservedAt: last.ObservedAt.Time,
			ID:         last.ID,
			SortNull:   last.SortNull,
			SortText:   last.SortText,
			SortNumber: last.SortNumber,
		})
		rows = rows[:pageSize]
	}
	result.Columns = append(result.Columns, (*widget.Columns)...)
	for _, row := range rows {
		result.Rows = append(result.Rows, gatewayapi.DashboardTableRow{Cells: row.Cells})
	}
	return nil
}

func (s *Service) listDashboards(w http.ResponseWriter, r *http.Request, workspaceID, agentName string, limit *gatewayapi.LimitQuery, pageToken *gatewayapi.PageTokenQuery) {
	pageSize := int32(50)
	if limit != nil {
		pageSize = *limit
	}
	cursor, cursorSet, ok := decodeCursorPageToken[dashboardCursor](w, r, pageToken)
	if !ok {
		return
	}
	if cursorSet && (cursor.UpdatedAt.IsZero() || cursor.ID == "") {
		writeInvalidPageToken(w, r, errors.New("invalid dashboard cursor"))
		return
	}
	rows, err := s.queries.GatewayListDashboards(r.Context(), gatewaydb.GatewayListDashboardsParams{
		WorkspaceID: workspaceID, AgentFilterSet: agentName != "", AgentName: agentName,
		CursorSet: cursorSet,
		CursorUpdatedAt: pgtype.Timestamptz{
			Time: cursor.UpdatedAt, Valid: cursorSet,
		},
		CursorID: cursor.ID, PageSize: pageSize + 1,
	})
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list dashboards: %w", err))
		return
	}
	next := ""
	if len(rows) > int(pageSize) {
		last := rows[pageSize-1]
		next = encodeCursorPageToken(dashboardCursor{UpdatedAt: last.UpdatedAt.Time, ID: last.ID})
		rows = rows[:pageSize]
	}
	summaries := make([]gatewayapi.DashboardSummary, 0, len(rows))
	for _, row := range rows {
		var definition gatewayapi.DashboardDefinition
		if err := json.Unmarshal(row.Definition, &definition); err != nil {
			writeInternalError(w, r, fmt.Errorf("decode dashboard %q: %w", row.ID, err))
			return
		}
		summaries = append(summaries, gatewayapi.DashboardSummary{
			Id: row.ID, AgentName: row.AgentName, Name: row.Name, Revision: row.Revision,
			Title: definition.Title, Description: definition.Description,
			WidgetCount: int64(len(definition.Widgets)), UpdatedAt: row.UpdatedAt.Time,
		})
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListDashboardsResponse{
		Dashboards:    summaries,
		NextPageToken: next,
	})
}

func (s *Service) writeStoredDashboard(w http.ResponseWriter, r *http.Request, row storedDashboard, status int) {
	var definition gatewayapi.DashboardDefinition
	if err := json.Unmarshal(row.Definition, &definition); err != nil {
		writeInternalError(w, r, fmt.Errorf("decode dashboard %q: %w", row.ID, err))
		return
	}
	writeJSON(w, status, gatewayapi.Dashboard{
		Id: row.ID, AgentName: row.AgentName, Revision: row.Revision, Definition: definition,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	})
}

func (s *Service) dashboardAgentSession(w http.ResponseWriter, r *http.Request, agentName, sessionID string) (requestAuth, gatewaydb.ChatSessionKind, bool) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.actorType != requestActorSystem || auth.actorName != agentName {
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"this session cannot access dashboards for the Agent",
			errors.New("invalid agent request identity"),
		))
		return requestAuth{}, "", false
	}
	tenant, workspaceID, err := s.tenantScopeForNamespace(r.Context(), auth.tenantNamespace)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve dashboard tenant scope: %w", err))
		return requestAuth{}, "", false
	}
	if workspaceID == "" {
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"this Agent does not belong to a Workspace",
			errors.New("dashboard requests require a workspace ID"),
		))
		return requestAuth{}, "", false
	}
	auth.organizationID = tenant.Spec.OrganizationID
	auth.workspaceID = workspaceID
	kind, err := s.queries.GatewayGetDashboardSessionKind(
		r.Context(),
		gatewaydb.GatewayGetDashboardSessionKindParams{
			WorkspaceID: auth.workspaceID,
			AgentName:   agentName,
			SessionID:   sessionID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"OpenCode session is not registered",
			err,
		))
		return requestAuth{}, "", false
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("resolve dashboard session: %w", err))
		return requestAuth{}, "", false
	}
	return auth, kind, true
}

func requireInteractiveDashboardSession(w http.ResponseWriter, r *http.Request, kind gatewaydb.ChatSessionKind) bool {
	if kind == gatewaydb.ChatSessionKindChat {
		return true
	}
	writeError(w, r, newAPIError(
		http.StatusForbidden,
		"forbidden",
		"scheduled workflows can publish dashboard data but cannot change dashboards",
		errors.New("interactive session required"),
	))
	return false
}

func (s *Service) consumeDashboardRateLimit(w http.ResponseWriter, r *http.Request, key string, delta, maximum int, window time.Duration) bool {
	started := time.Now().UTC().Truncate(window)
	digest := sha256.Sum256([]byte(key))
	_, err := s.queries.GatewayConsumeDashboardRateLimit(
		r.Context(),
		gatewaydb.GatewayConsumeDashboardRateLimitParams{
			Key:             hex.EncodeToString(digest[:]),
			WindowStartedAt: pgtype.Timestamptz{Time: started, Valid: true},
			Delta:           int32(delta),
			MaxCount:        int32(maximum),
		},
	)
	if err == nil {
		return true
	}
	if errors.Is(err, pgx.ErrNoRows) {
		retry := max(1, int(time.Until(started.Add(window)).Seconds()))
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
		writeError(w, r, newAPIError(
			http.StatusTooManyRequests,
			"rate_limited",
			"dashboard request limit reached",
			err,
		))
		return false
	}
	writeInternalError(w, r, fmt.Errorf("consume dashboard rate limit: %w", err))
	return false
}

func validateDashboardDefinition(definition gatewayapi.DashboardDefinition) error {
	if len(definition.Dimensions)+len(definition.Measures) > dashboardMaxFields {
		return fmt.Errorf(
			"dashboard may declare at most %d fields across dimensions and measures",
			dashboardMaxFields,
		)
	}
	if len(definition.Filters) > dashboardMaxFilters {
		return fmt.Errorf("dashboard may declare at most %d filters", dashboardMaxFilters)
	}
	if len(definition.Widgets) > dashboardMaxWidgets {
		return fmt.Errorf("dashboard may declare at most %d widgets", dashboardMaxWidgets)
	}
	dimensions := make(map[string]struct{}, len(definition.Dimensions))
	measures := make(map[string]struct{}, len(definition.Measures))
	for _, dimension := range definition.Dimensions {
		if _, exists := dimensions[dimension.Name]; exists {
			return fmt.Errorf("dimension %q is duplicated", dimension.Name)
		}
		dimensions[dimension.Name] = struct{}{}
	}
	for _, measure := range definition.Measures {
		if _, exists := dimensions[measure.Name]; exists {
			return fmt.Errorf("field %q cannot be both a dimension and a measure", measure.Name)
		}
		if _, exists := measures[measure.Name]; exists {
			return fmt.Errorf("measure %q is duplicated", measure.Name)
		}
		measures[measure.Name] = struct{}{}
	}
	filterIDs := make(map[string]struct{}, len(definition.Filters))
	for _, filter := range definition.Filters {
		if _, exists := filterIDs[filter.Id]; exists {
			return fmt.Errorf("filter %q is duplicated", filter.Id)
		}
		if _, exists := dimensions[filter.Field]; !exists {
			return fmt.Errorf("filter %q references unknown dimension %q", filter.Id, filter.Field)
		}
		filterIDs[filter.Id] = struct{}{}
	}
	widgetIDs := make(map[string]struct{}, len(definition.Widgets))
	for _, widget := range definition.Widgets {
		if _, exists := widgetIDs[widget.Id]; exists {
			return fmt.Errorf("widget %q is duplicated", widget.Id)
		}
		widgetIDs[widget.Id] = struct{}{}
		switch widget.Kind {
		case gatewayapi.DashboardWidgetMetric,
			gatewayapi.DashboardWidgetLine,
			gatewayapi.DashboardWidgetArea,
			gatewayapi.DashboardWidgetBar,
			gatewayapi.DashboardWidgetDonut:
			if widget.Measure == nil || widget.Aggregation == nil {
				return fmt.Errorf("widget %q requires measure and aggregation", widget.Id)
			}
			switch *widget.Aggregation {
			case gatewayapi.Avg, gatewayapi.Count, gatewayapi.Max, gatewayapi.Min, gatewayapi.Sum:
			default:
				return fmt.Errorf("widget %q has unsupported aggregation %q", widget.Id, *widget.Aggregation)
			}
			if _, exists := measures[*widget.Measure]; !exists {
				return fmt.Errorf("widget %q references unknown measure %q", widget.Id, *widget.Measure)
			}
			if widget.GroupBy != nil {
				if _, exists := dimensions[*widget.GroupBy]; !exists {
					return fmt.Errorf("widget %q references unknown dimension %q", widget.Id, *widget.GroupBy)
				}
			}
			if widget.Columns != nil || widget.SortBy != nil || widget.SortDirection != nil {
				return fmt.Errorf("widget %q has table-only properties", widget.Id)
			}
			switch widget.Kind {
			case gatewayapi.DashboardWidgetMetric:
				if widget.GroupBy != nil || widget.Stacked != nil || widget.Limit != nil {
					return fmt.Errorf("metric widget %q has unsupported properties", widget.Id)
				}
			case gatewayapi.DashboardWidgetLine:
				if widget.Stacked != nil || widget.Limit != nil {
					return fmt.Errorf("line widget %q has unsupported properties", widget.Id)
				}
			case gatewayapi.DashboardWidgetArea, gatewayapi.DashboardWidgetBar:
				if widget.Limit != nil {
					return fmt.Errorf("widget %q does not support limit", widget.Id)
				}
			case gatewayapi.DashboardWidgetDonut:
				if widget.GroupBy == nil {
					return fmt.Errorf("donut widget %q requires group_by", widget.Id)
				}
				if widget.Stacked != nil {
					return fmt.Errorf("donut widget %q does not support stacked", widget.Id)
				}
			}
		case gatewayapi.DashboardWidgetTable:
			if widget.Measure != nil || widget.Aggregation != nil || widget.GroupBy != nil ||
				widget.Stacked != nil {
				return fmt.Errorf("table widget %q has chart-only properties", widget.Id)
			}
			if widget.Limit != nil {
				return fmt.Errorf("table widget %q cannot declare a row limit", widget.Id)
			}
			if widget.Columns == nil || len(*widget.Columns) == 0 {
				return fmt.Errorf("table widget %q requires columns", widget.Id)
			}
			if len(*widget.Columns) > dashboardMaxFields {
				return fmt.Errorf(
					"table widget %q may declare at most %d columns",
					widget.Id,
					dashboardMaxFields,
				)
			}
			columns := make(map[string]struct{}, len(*widget.Columns))
			for _, column := range *widget.Columns {
				if _, duplicate := columns[column]; duplicate {
					return fmt.Errorf("table widget %q column %q is duplicated", widget.Id, column)
				}
				columns[column] = struct{}{}
				if _, dimension := dimensions[column]; dimension {
					continue
				}
				if _, measure := measures[column]; !measure {
					return fmt.Errorf("table widget %q references unknown field %q", widget.Id, column)
				}
			}
			if widget.SortBy == nil && widget.SortDirection != nil {
				return fmt.Errorf("table widget %q sort_direction requires sort_by", widget.Id)
			}
			if widget.SortBy != nil {
				found := false
				for _, column := range *widget.Columns {
					found = found || column == *widget.SortBy
				}
				if !found {
					return fmt.Errorf("table widget %q sort_by must reference one of its columns", widget.Id)
				}
			}
		default:
			return fmt.Errorf("widget %q has unsupported kind %q", widget.Id, widget.Kind)
		}
	}
	return nil
}

func encodeDashboardRecords(definition gatewayapi.DashboardDefinition, req gatewayapi.WriteDashboardDataRequest) ([]byte, error) {
	switch req.Action {
	case gatewayapi.Append, gatewayapi.Upsert:
	default:
		return nil, fmt.Errorf("unsupported data action %q", req.Action)
	}
	dimensions := make(map[string]struct{}, len(definition.Dimensions))
	for _, field := range definition.Dimensions {
		dimensions[field.Name] = struct{}{}
	}
	measures := make(map[string]struct{}, len(definition.Measures))
	for _, field := range definition.Measures {
		measures[field.Name] = struct{}{}
	}
	now := time.Now()
	keys := make(map[string]struct{}, len(req.Records))
	records := make([]dashboardRecordInput, 0, len(req.Records))
	for index, record := range req.Records {
		tooOld := record.ObservedAt.Before(now.Add(-dashboardRetention))
		tooNew := record.ObservedAt.After(now.Add(5 * time.Minute))
		if tooOld || tooNew {
			return nil, fmt.Errorf(
				"records[%d].observed_at must be between 30 days ago and 5 minutes from now",
				index,
			)
		}
		if req.Action == gatewayapi.Upsert && record.RecordKey == nil {
			return nil, fmt.Errorf("records[%d].record_key is required for upsert", index)
		}
		if record.RecordKey != nil {
			if _, exists := keys[*record.RecordKey]; exists {
				return nil, fmt.Errorf("records[%d].record_key duplicates %q", index, *record.RecordKey)
			}
			keys[*record.RecordKey] = struct{}{}
		}
		for name := range record.Dimensions {
			if _, exists := dimensions[name]; !exists {
				return nil, fmt.Errorf("records[%d].dimensions contains unknown field %q", index, name)
			}
		}
		for name, value := range record.Measures {
			if _, exists := measures[name]; !exists {
				return nil, fmt.Errorf("records[%d].measures contains unknown field %q", index, name)
			}
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, fmt.Errorf("records[%d].measures.%s must be finite", index, name)
			}
		}
		records = append(records, dashboardRecordInput{
			ID: uuid.NewString(), RecordKey: record.RecordKey, ObservedAt: record.ObservedAt,
			Dimensions: record.Dimensions, Measures: record.Measures,
		})
	}
	return json.Marshal(records)
}

func (s *Service) runDashboardRetention(ctx context.Context) {
	ticker := time.NewTicker(dashboardRetentionSweep)
	defer ticker.Stop()
	for {
		for {
			deleted, err := s.queries.GatewayDeleteExpiredDashboardRecords(ctx, 1000)
			if err != nil {
				if ctx.Err() == nil {
					slog.ErrorContext(ctx, "delete expired dashboard records", slog.Any("err", err))
				}
				break
			}
			if deleted < 1000 {
				break
			}
		}
		_, err := s.queries.GatewayDeleteExpiredDashboardRateLimits(
			ctx,
			pgtype.Timestamptz{
				Time: time.Now().Add(-2 * time.Hour), Valid: true,
			},
		)
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "delete expired dashboard rate limits", slog.Any("err", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
