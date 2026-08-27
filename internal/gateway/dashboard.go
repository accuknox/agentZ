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

type dashboardQuotaLimitError struct {
	field      string
	message    string
	attempted  int64
	limit      int64
	retryAfter time.Duration
	cause      error
}

func (e *dashboardQuotaLimitError) Error() string {
	return e.message
}

func (e *dashboardQuotaLimitError) Unwrap() error {
	return e.cause
}

// ListDashboards lists dashboards visible in the selected Workspace.
func (s *Service) ListDashboards(w http.ResponseWriter, r *http.Request, params gatewayapi.ListDashboardsParams) {
	s.listDashboards(w, r, params.AgentName, params.PageToken)
}

// ListAgentDashboards lists dashboards owned by one Agent.
func (s *Service) ListAgentDashboards(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, params gatewayapi.ListAgentDashboardsParams) {
	s.listDashboards(w, r, &agentName, params.PageToken)
}

func (s *Service) listDashboards(w http.ResponseWriter, r *http.Request, agentName *string, token *gatewayapi.PageTokenQuery) {
	auth, ok := requestAuthState(r.Context())
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing dashboard request scope",
			errBadRequest,
		))
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
	}
	if agentName != nil && (auth.tenantNamespace == "" || auth.workspaceID == "") {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing dashboard request scope",
			errBadRequest,
		))
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
	writeJSON(w, http.StatusOK, gatewayapi.ListDashboardsResponse{
		Dashboards:    items,
		NextPageToken: next,
	})
}

// CreateDashboard validates and stores an immutable dashboard definition.
func (s *Service) CreateDashboard(w http.ResponseWriter, r *http.Request, agentName gatewayapi.AgentNamePath, _ gatewayapi.CreateDashboardParams) {
	auth, quota, ok := dashboardRequestState(w, r)
	if !ok {
		return
	}
	var req gatewayapi.CreateDashboardRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	err := validateDashboard(req, quota.WidgetsPerDashboard)
	if err != nil {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_dashboard",
				"dashboard definition is invalid",
				err,
				gatewayapi.FieldError{Field: "dashboard", Message: err.Error()},
			),
		)
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, r, mapDashboardStoreError("create dashboard", err))
		return
	}
	defer tx.Rollback(r.Context())
	queries := dashboarddb.New(tx)
	_, err = queries.DashboardLockAgent(r.Context(), dashboarddb.DashboardLockAgentParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("lock agent dashboard quota", err))
		return
	}

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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusTooManyRequests,
				"dashboard_quota_exceeded",
				"agent dashboard limit reached; delete a dashboard before retrying",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "name",
					Message: fmt.Sprintf(
						"agent may own at most %d dashboards",
						quota.DashboardsPerAgent,
					),
				},
			),
		)
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
	err = queries.DashboardCreateWidgets(r.Context(), dashboarddb.DashboardCreateWidgetsParams{
		DashboardID:     created.ID,
		TenantNamespace: auth.tenantNamespace,
		Widgets:         rawWidgets,
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("create dashboard widgets", err))
		return
	}
	err = tx.Commit(r.Context())
	if err != nil {
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

// GetDashboard returns one dashboard definition and its widget revisions.
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
			Axes:         definition.Axes,
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

// DeleteDashboard removes a dashboard definition and all stored data.
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

// PublishDashboardData validates and stores one idempotent widget update.
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_dashboard_data",
				"dashboard data is invalid",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "records",
					Message: fmt.Sprintf(
						"must contain between 1 and %d records",
						quota.Publish.RecordsPerRequest,
					),
				},
			),
		)
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusConflict,
				"stale_dashboard_revision",
				"widget definition changed; get the dashboard and retry with its current data_revision",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "data_revision",
					Message: "does not match the current widget revision",
				},
			),
		)
		return
	}
	var definition gatewayapi.DashboardWidgetDefinition
	err = json.Unmarshal(widget.Definition, &definition)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("decode stored widget definition: %w", err))
		return
	}
	err = validateDashboardRecords(definition, req.Records, receivedAt)
	if err != nil {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_dashboard_data",
				"dashboard data does not match the widget definition",
				err,
				gatewayapi.FieldError{Field: "records", Message: err.Error()},
			),
		)
		return
	}

	replay, replayErr := queries.DashboardGetPublishReplay(
		r.Context(),
		dashboarddb.DashboardGetPublishReplayParams{
			TenantNamespace: auth.tenantNamespace,
			AgentName:       agentName,
			IdempotencyKey:  params.IdempotencyKey,
		},
	)
	if replayErr == nil {
		if !bytes.Equal(replay.RequestHash, hash[:]) {
			writeError(
				w,
				r,
				newAPIError(
					http.StatusConflict,
					"idempotency_conflict",
					"idempotency key was already used with different data",
					errBadRequest,
					gatewayapi.FieldError{
						Field:   "Idempotency-Key",
						Message: "must be unique for a different request body",
					},
				),
			)
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
		stored[i] = dashboardStoredRecord{
			RecordedAt: recordedAt,
			Payload:    record,
			ByteSize:   len(raw),
		}
		acceptedBytes += int64(len(raw))
	}
	storedJSON, err := json.Marshal(stored)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard records: %w", err))
		return
	}

	minute := receivedAt.Truncate(time.Minute)
	_, err = queries.DashboardReservePublishWindow(
		r.Context(),
		dashboarddb.DashboardReservePublishWindowParams{
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
		},
	)
	if err != nil {
		writeDashboardQuotaError(w, r, &dashboardQuotaLimitError{
			field:      "spec.dashboardQuota.publish.requestsPerMinutePerAgent",
			message:    "publish rate limit reached; retry after the current minute",
			attempted:  1,
			limit:      int64(quota.Publish.RequestsPerMinutePerAgent),
			retryAfter: time.Until(minute.Add(time.Minute)),
			cause:      err,
		})
		return
	}
	temporalRecords := int64(0)
	if definition.Mode == gatewayapi.Temporal {
		temporalRecords = int64(len(req.Records))
	}
	day := receivedAt.Truncate(24 * time.Hour)
	_, err = queries.DashboardReservePublishWindow(
		r.Context(),
		dashboarddb.DashboardReservePublishWindowParams{
			TenantNamespace: auth.tenantNamespace,
			AgentName:       agentName,
			WindowKind:      "day",
			WindowStart:     day,
			Calls:           0,
			Records:         0,
			Bytes:           acceptedBytes,
			MaxCalls:        math.MaxInt64,
			MaxRecords:      math.MaxInt64,
			MaxBytes:        quota.Publish.AcceptedBytesPerDay.Value(),
		},
	)
	if err != nil {
		writeDashboardQuotaError(w, r, &dashboardQuotaLimitError{
			field:      "spec.dashboardQuota.publish.acceptedBytesPerDay",
			message:    "daily accepted-byte quota reached; retry on the next UTC day",
			attempted:  acceptedBytes,
			limit:      quota.Publish.AcceptedBytesPerDay.Value(),
			retryAfter: time.Until(day.Add(24 * time.Hour)),
			cause:      err,
		})
		return
	}
	_, err = queries.DashboardReservePublishWindow(
		r.Context(),
		dashboarddb.DashboardReservePublishWindowParams{
			TenantNamespace: auth.tenantNamespace,
			AgentName:       agentName,
			WindowKind:      "day",
			WindowStart:     day,
			Calls:           0,
			Records:         temporalRecords,
			Bytes:           0,
			MaxCalls:        math.MaxInt64,
			MaxRecords:      quota.Publish.TemporalRecordsPerDay,
			MaxBytes:        math.MaxInt64,
		},
	)
	if err != nil {
		writeDashboardQuotaError(w, r, &dashboardQuotaLimitError{
			field:      "spec.dashboardQuota.publish.temporalRecordsPerDay",
			message:    "daily temporal-record quota reached; retry on the next UTC day",
			attempted:  temporalRecords,
			limit:      quota.Publish.TemporalRecordsPerDay,
			retryAfter: time.Until(day.Add(24 * time.Hour)),
			cause:      err,
		})
		return
	}

	switch definition.Mode {
	case gatewayapi.Temporal:
		_, err = queries.DashboardReserveTemporalUsage(
			r.Context(),
			dashboarddb.DashboardReserveTemporalUsageParams{
				TenantNamespace: auth.tenantNamespace,
				Records:         int64(len(req.Records)),
				Bytes:           acceptedBytes,
				MaxRecords:      quota.Publish.RetainedTemporalRecords,
			},
		)
		if err != nil {
			writeDashboardQuotaError(w, r, &dashboardQuotaLimitError{
				field:     "spec.dashboardQuota.publish.retainedTemporalRecords",
				message:   "retained temporal-record quota reached; wait for retention cleanup or delete a dashboard",
				attempted: int64(len(req.Records)),
				limit:     quota.Publish.RetainedTemporalRecords,
				cause:     err,
			})
			return
		}
		inserted, err := queries.DashboardInsertTemporalRecords(
			r.Context(),
			dashboarddb.DashboardInsertTemporalRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				Records:         storedJSON,
			},
		)
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
		_, err = queries.DashboardReserveLatestUsage(
			r.Context(),
			dashboarddb.DashboardReserveLatestUsageParams{
				TenantNamespace: auth.tenantNamespace,
				AgentName:       agentName,
				DeltaBytes:      acceptedBytes - oldBytes,
				MaxBytes:        quota.Publish.LatestBytesPerAgent.Value(),
			},
		)
		if err != nil {
			writeDashboardQuotaError(w, r, &dashboardQuotaLimitError{
				field:     "spec.dashboardQuota.publish.latestBytesPerAgent",
				message:   "latest dashboard data exceeds the Agent byte quota; publish fewer or smaller records",
				attempted: acceptedBytes,
				limit:     quota.Publish.LatestBytesPerAgent.Value(),
				cause:     err,
			})
			return
		}
		err = queries.DashboardReplaceLatestRecords(
			r.Context(),
			dashboarddb.DashboardReplaceLatestRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				ReceivedAt:      receivedAt,
				Records:         storedJSON,
			},
		)
		if err != nil {
			writeError(w, r, mapDashboardStoreError("replace latest dashboard data", err))
			return
		}
	}

	err = queries.DashboardSavePublishReplay(r.Context(), dashboarddb.DashboardSavePublishReplayParams{
		TenantNamespace: auth.tenantNamespace,
		AgentName:       agentName,
		IdempotencyKey:  params.IdempotencyKey,
		RequestHash:     hash[:],
		ReceivedAt:      receivedAt,
		AcceptedRecords: int32(len(req.Records)),
	})
	if err != nil {
		writeError(w, r, mapDashboardStoreError("save publish idempotency", err))
		return
	}
	err = tx.Commit(r.Context())
	if err != nil {
		writeError(w, r, mapDashboardStoreError("commit dashboard publish", err))
		return
	}
	writeJSON(w, http.StatusOK, gatewayapi.PublishDashboardDataResponse{
		AcceptedRecords: int32(len(req.Records)),
		ReceivedAt:      receivedAt,
		Replayed:        false,
	})
}

func writeDashboardQuotaError(w http.ResponseWriter, r *http.Request, limit *dashboardQuotaLimitError) {
	if !errors.Is(limit, pgx.ErrNoRows) {
		writeError(w, r, mapDashboardStoreError("reserve dashboard quota", limit))
		return
	}
	if limit.retryAfter > 0 {
		seconds := max(int64(limit.retryAfter.Round(time.Second)/time.Second), 1)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", seconds))
	}
	writeError(
		w,
		r,
		newAPIError(
			http.StatusTooManyRequests,
			"dashboard_quota_exceeded",
			limit.message,
			limit,
			gatewayapi.FieldError{
				Field: limit.field,
				Message: fmt.Sprintf(
					"this request adds %d; the configured maximum is %d",
					limit.attempted,
					limit.limit,
				),
			},
		),
	)
}

func writeDashboardQueryReservationError(w http.ResponseWriter, r *http.Request, err error) {
	var limit *dashboardQuotaLimitError
	if errors.As(err, &limit) {
		writeDashboardQuotaError(w, r, limit)
		return
	}
	writeError(w, r, mapDashboardStoreError("reserve dashboard query", err))
}

func mapDashboardStoreError(action string, err error) *apiError {
	if errors.Is(err, pgx.ErrNoRows) {
		return newAPIError(http.StatusNotFound, "not_found", "dashboard resource not found", err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return newAPIError(
			http.StatusGatewayTimeout,
			"dashboard_query_timeout",
			"dashboard query timed out",
			err,
		)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "57014" {
		return newAPIError(
			http.StatusGatewayTimeout,
			"dashboard_query_timeout",
			"dashboard query timed out",
			err,
		)
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
			removed, err := s.dashboards.DashboardDeleteExpired(
				batchCtx,
				dashboarddb.DashboardDeleteExpiredParams{
					Cutoff:    now.Add(-dashboardRetention),
					BatchSize: 1000,
				},
			)
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
			slog.InfoContext(
				ctx,
				"deleted expired dashboard records",
				slog.Int64("records", deletedRecords),
				slog.Int64("bytes", deletedBytes),
			)
		}
		err := s.dashboards.DashboardDeleteExpiredAccounting(
			ctx,
			now.Add(-dashboardRetention),
		)
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "delete expired dashboard idempotency records", slog.Any("err", err))
		}
		err = s.dashboards.DashboardDeleteExpiredWindows(
			ctx,
			now.Add(-48*time.Hour),
		)
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "delete expired dashboard quota windows", slog.Any("err", err))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// QueryDashboard reads chart data for a dashboard over one time range.
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_time_range",
				"dashboard time range is invalid",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "to",
					Message: "must be after from and no more than 30 days later",
				},
			),
		)
		return
	}
	maxPoints := int32(240)
	if req.MaxPoints != nil {
		maxPoints = *req.MaxPoints
	}
	if maxPoints < 1 || maxPoints > quota.Query.PointsPerSeries {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_max_points",
				"max_points is outside the configured limit",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "max_points",
					Message: fmt.Sprintf(
						"must be between 1 and %d",
						quota.Query.PointsPerSeries,
					),
				},
			),
		)
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
	allWidgets, err := s.dashboards.DashboardListWidgets(
		r.Context(),
		dashboarddb.DashboardListWidgetsParams{
			TenantNamespace: auth.tenantNamespace,
			DashboardID:     stored.ID,
		},
	)
	if err != nil {
		writeError(w, r, mapDashboardStoreError("list dashboard widgets", err))
		return
	}
	widgets := selectedDashboardWidgets(allWidgets, req.Widgets)
	if req.Widgets != nil && len(widgets) != len(*req.Widgets) {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusNotFound,
				"widget_not_found",
				"one or more requested widgets do not exist",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "widgets",
					Message: "must contain only widget names from this dashboard",
				},
			),
		)
		return
	}

	definitions := make([]gatewayapi.DashboardWidgetDefinition, len(widgets))
	for i, widget := range widgets {
		err = json.Unmarshal(widget.Definition, &definitions[i])
		if err != nil {
			writeInternalError(w, r, fmt.Errorf("decode widget %q definition: %w", widget.Name, err))
			return
		}
	}
	lease, err := s.reserveDashboardQuery(r.Context(), auth, quota)
	if err != nil {
		writeDashboardQueryReservationError(w, r, err)
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
	_, err = queries.DashboardSetStatementTimeout(
		ctx,
		fmt.Sprintf("%dms", quota.Query.Timeout.Milliseconds()),
	)
	if err != nil {
		writeError(w, r, mapDashboardStoreError("set dashboard query timeout", err))
		return
	}

	results := make([]gatewayapi.DashboardWidgetQueryResult, 0, len(widgets))
	var returnedCells int64
	for i, widget := range widgets {
		definition := definitions[i]
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
			SankeyNodes:  []gatewayapi.DashboardSankeyNode{},
			SankeyLinks:  []gatewayapi.DashboardSankeyLink{},
		}
		invalid, err := queries.DashboardCountInvalidRecords(
			ctx,
			dashboarddb.DashboardCountInvalidRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				FromTime:        req.From,
				ToTime:          req.To,
			},
		)
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
			rows, queryErr := queries.DashboardBucketTimeSeries(
				ctx,
				dashboarddb.DashboardBucketTimeSeriesParams{
					TenantNamespace: auth.tenantNamespace,
					WidgetRevision:  widget.Revision,
					BucketSeconds:   bucketSeconds,
					FromTime:        req.From,
					ToTime:          req.To,
				},
			)
			if queryErr != nil {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.BucketSeconds = new(int64)
			*result.BucketSeconds = int64(bucketSeconds)
			result.Points = make([]gatewayapi.DashboardTimePoint, len(rows))
			for i, row := range rows {
				err = json.Unmarshal(row.Values, &result.Points[i].Values)
				if err != nil {
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
			if result.Error == nil {
				for _, point := range result.Points {
					returnedCells += int64(len(point.Values) + 1)
				}
			}
		case gatewayapi.Pie, gatewayapi.Bar, gatewayapi.HorizontalGroupedBar:
			categoryLimit := int32(12)
			if definition.Kind == gatewayapi.Pie {
				categoryLimit = 4
			}
			rows, queryErr := queries.DashboardAggregateCategories(
				ctx,
				dashboarddb.DashboardAggregateCategoriesParams{
					TenantNamespace: auth.tenantNamespace,
					WidgetRevision:  widget.Revision,
					FromTime:        req.From,
					ToTime:          req.To,
					MaxCategories:   categoryLimit,
				},
			)
			if queryErr != nil {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.Categories = make([]gatewayapi.DashboardCategory, len(rows))
			for i, row := range rows {
				result.Categories[i].Label = row.Label
				err = json.Unmarshal(row.Values, &result.Categories[i].Values)
				if err != nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Categories = []gatewayapi.DashboardCategory{}
					break
				}
			}
			if len(result.Categories) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
			if result.Error == nil {
				for _, category := range result.Categories {
					returnedCells += int64(len(category.Values) + 1)
				}
			}
		case gatewayapi.Funnel, gatewayapi.HorizontalFunnel:
			rows, queryErr := queries.DashboardReadRecords(ctx, dashboarddb.DashboardReadRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				RowLimit:        100,
			})
			if queryErr != nil {
				writeError(w, r, mapDashboardStoreError("query funnel", queryErr))
				return
			}
			result.Categories = make([]gatewayapi.DashboardCategory, len(rows))
			for i, row := range rows {
				var record gatewayapi.DashboardDataRecord
				err = json.Unmarshal(row.Payload, &record)
				if err != nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Categories = []gatewayapi.DashboardCategory{}
					break
				}
				result.Categories[i] = gatewayapi.DashboardCategory{
					Label:  *record.Category,
					Values: *record.Values,
				}
			}
			if len(result.Categories) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
			if result.Error == nil {
				for _, category := range result.Categories {
					returnedCells += int64(len(category.Values) + 1)
				}
			}
		case gatewayapi.Sankey:
			rows, queryErr := queries.DashboardReadRecords(ctx, dashboarddb.DashboardReadRecordsParams{
				TenantNamespace: auth.tenantNamespace,
				WidgetRevision:  widget.Revision,
				RowLimit:        100,
			})
			if queryErr != nil {
				writeError(w, r, mapDashboardStoreError("query sankey", queryErr))
				return
			}
			indices := make(map[string]int32, len(rows)+1)
			for _, row := range rows {
				var record gatewayapi.DashboardDataRecord
				err = json.Unmarshal(row.Payload, &record)
				if err != nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.SankeyNodes = []gatewayapi.DashboardSankeyNode{}
					result.SankeyLinks = []gatewayapi.DashboardSankeyLink{}
					break
				}
				source, ok := indices[*record.Source]
				if !ok {
					source = int32(len(result.SankeyNodes))
					indices[*record.Source] = source
					result.SankeyNodes = append(result.SankeyNodes,
						gatewayapi.DashboardSankeyNode{Name: *record.Source})
				}
				target, ok := indices[*record.Target]
				if !ok {
					target = int32(len(result.SankeyNodes))
					indices[*record.Target] = target
					result.SankeyNodes = append(result.SankeyNodes,
						gatewayapi.DashboardSankeyNode{Name: *record.Target})
				}
				result.SankeyLinks = append(result.SankeyLinks, gatewayapi.DashboardSankeyLink{
					Source: source,
					Target: target,
					Value:  *record.Value,
				})
			}
			if len(result.SankeyLinks) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
			if result.Error == nil {
				returnedCells += int64(len(result.SankeyNodes) + 3*len(result.SankeyLinks))
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
				err = json.Unmarshal(raw, &record)
				if err != nil || record.Series == nil || record.X == nil || record.Y == nil {
					result.Status = gatewayapi.InvalidData
					result.Error = dashboardDataError(1)
					result.Scatter = []gatewayapi.DashboardScatterPoint{}
					break
				}
				result.Scatter[i] = gatewayapi.DashboardScatterPoint{
					Series: *record.Series,
					X:      *record.X,
					Y:      *record.Y,
					Label:  record.Label,
				}
			}
			if len(result.Scatter) == 0 && result.Error == nil {
				result.Status = gatewayapi.Empty
			}
			if result.Error == nil {
				returnedCells += int64(3 * len(result.Scatter))
				for _, point := range result.Scatter {
					if point.Label != nil {
						returnedCells++
					}
				}
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
			err = json.Unmarshal(rows[0].Payload, &record)
			if err != nil || record.Values == nil || len(*record.Values) != 1 {
				result.Status = gatewayapi.InvalidData
				result.Error = dashboardDataError(1)
				break
			}
			result.Value = new(float64)
			*result.Value = (*record.Values)[0]
			returnedCells++
		}
		results = append(results, result)
	}
	err = tx.Commit(ctx)
	if err != nil {
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusTooManyRequests,
				"dashboard_response_limit_exceeded",
				"query response exceeds the byte limit; request fewer widgets or points",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "spec.dashboardQuota.query.responseBytes",
					Message: fmt.Sprintf(
						"response is %d bytes; the configured maximum is %d",
						len(raw),
						quota.Query.ResponseBytes.Value(),
					),
				},
			),
		)
		return
	}
	if returnedCells > int64(quota.Query.CellsPerRequest) {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusTooManyRequests,
				"dashboard_query_limit_exceeded",
				"query returned too many cells; request fewer widgets or points",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "max_points",
					Message: fmt.Sprintf(
						"returned %d cells; the configured maximum is %d",
						returnedCells,
						quota.Query.CellsPerRequest,
					),
				},
			),
		)
		return
	}
	cellLimit := s.reserveDashboardCells(r.Context(), auth, quota, returnedCells)
	if cellLimit != nil {
		writeDashboardQuotaError(w, r, cellLimit)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// ListDashboardTableRows returns one page of validated table rows.
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
	err = json.Unmarshal(widget.Definition, &definition)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("decode table definition: %w", err))
		return
	}
	if definition.Kind != gatewayapi.Table {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_widget_kind",
				"row pagination is only available for table widgets",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "widget_name",
					Message: "must identify a table widget",
				},
			),
		)
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
		writeError(
			w,
			r,
			newAPIError(
				http.StatusUnprocessableEntity,
				"invalid_time_range",
				"dashboard table time range is invalid",
				errBadRequest,
				gatewayapi.FieldError{
					Field:   "event_time_before",
					Message: "must be after event_time_after and no more than 30 days later",
				},
			),
		)
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
	var sortIndices [3]pgtype.Int4
	var sortAscending [3]bool
	var sortDatetime [3]bool
	if params.Sort != nil {
		if len(*params.Sort) > len(sortIndices) {
			writeError(
				w,
				r,
				newAPIError(
					http.StatusUnprocessableEntity,
					"invalid_sort",
					"at most three sort columns are allowed",
					errBadRequest,
					gatewayapi.FieldError{
						Field:   "sort",
						Message: "must contain at most three entries",
					},
				),
			)
			return
		}
		for i, item := range *params.Sort {
			name, direction, found := strings.Cut(item, ":")
			if !found || (direction != "asc" && direction != "desc") {
				writeError(
					w,
					r,
					newAPIError(
						http.StatusUnprocessableEntity,
						"invalid_sort",
						"sort entry is invalid",
						errBadRequest,
						gatewayapi.FieldError{
							Field:   fmt.Sprintf("sort[%d]", i),
							Message: "must use column:asc or column:desc",
						},
					),
				)
				return
			}
			column := slices.IndexFunc(
				definition.Columns,
				func(column gatewayapi.DashboardTableColumn) bool {
					return column.Name == name && column.Sortable
				},
			)
			if column < 0 {
				writeError(
					w,
					r,
					newAPIError(
						http.StatusUnprocessableEntity,
						"invalid_sort",
						"sort column is not available",
						errBadRequest,
						gatewayapi.FieldError{
							Field: fmt.Sprintf("sort[%d]", i),
							Message: fmt.Sprintf(
								"column %q does not exist or is not sortable",
								name,
							),
						},
					),
				)
				return
			}
			sortIndices[i] = pgtype.Int4{Int32: int32(column), Valid: true}
			sortAscending[i] = direction == "asc"
			sortDatetime[i] = definition.Columns[column].Type ==
				gatewayapi.DashboardTableColumnTypeDatetime
		}
	}
	lease, err := s.reserveDashboardQuery(r.Context(), auth, quota)
	if err != nil {
		writeDashboardQueryReservationError(w, r, err)
		return
	}
	defer s.releaseDashboardQuery(auth.tenantNamespace, lease)

	ctx, cancel := context.WithTimeout(r.Context(), quota.Query.Timeout.Duration)
	defer cancel()
	invalid, err := s.dashboards.DashboardCountInvalidRecords(
		ctx,
		dashboarddb.DashboardCountInvalidRecordsParams{
			TenantNamespace: auth.tenantNamespace,
			WidgetRevision:  widget.Revision,
			FromTime:        from,
			ToTime:          to,
		},
	)
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
		Sort0Datetime:   sortDatetime[0],
		Sort0Index:      sortIndices[0],
		Sort1Ascending:  sortAscending[1],
		Sort1Datetime:   sortDatetime[1],
		Sort1Index:      sortIndices[1],
		Sort2Ascending:  sortAscending[2],
		Sort2Datetime:   sortDatetime[2],
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
		err = json.Unmarshal(row.Payload, &record)
		if err != nil || record.Cells == nil {
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
	response := gatewayapi.DashboardTablePage{
		Status:        status,
		Rows:          result,
		NextPageToken: next,
	}
	raw, err := json.Marshal(response)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("encode dashboard table page: %w", err))
		return
	}
	if int64(len(raw)) > quota.Query.ResponseBytes.Value() {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusTooManyRequests,
				"dashboard_response_limit_exceeded",
				"table response exceeds the byte limit; narrow the selected time range",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "spec.dashboardQuota.query.responseBytes",
					Message: fmt.Sprintf(
						"response is %d bytes; the configured maximum is %d",
						len(raw),
						quota.Query.ResponseBytes.Value(),
					),
				},
			),
		)
		return
	}
	returnedCells := int64(len(result) * len(definition.Columns))
	if returnedCells > int64(quota.Query.CellsPerRequest) {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusTooManyRequests,
				"dashboard_query_limit_exceeded",
				"table page returned too many cells; narrow the selected time range",
				errBadRequest,
				gatewayapi.FieldError{
					Field: "page_token",
					Message: fmt.Sprintf(
						"returned %d cells; the configured maximum is %d",
						returnedCells,
						quota.Query.CellsPerRequest,
					),
				},
			),
		)
		return
	}
	cellLimit := s.reserveDashboardCells(r.Context(), auth, quota, returnedCells)
	if cellLimit != nil {
		writeDashboardQuotaError(w, r, cellLimit)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (s *Service) reserveDashboardQuery(ctx context.Context, auth requestAuth, quota agentzv1alpha1.DashboardQuota) (uuid.UUID, error) {
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
	_, err = queries.DashboardReserveQueryWindow(ctx, dashboarddb.DashboardReserveQueryWindowParams{
		TenantNamespace: auth.tenantNamespace,
		SubjectID:       subject,
		WindowKind:      "minute",
		WindowStart:     now.Truncate(time.Minute),
		Calls:           1,
		Cells:           0,
		MaxCalls:        int64(quota.Query.RequestsPerMinutePerUser),
		MaxCells:        math.MaxInt64,
	})
	if err != nil {
		return uuid.Nil, &dashboardQuotaLimitError{
			field:      "spec.dashboardQuota.query.requestsPerMinutePerUser",
			message:    "dashboard query rate limit reached; retry after the current minute",
			attempted:  1,
			limit:      int64(quota.Query.RequestsPerMinutePerUser),
			retryAfter: time.Until(now.Truncate(time.Minute).Add(time.Minute)),
			cause:      err,
		}
	}
	token := uuid.New()
	_, err = queries.DashboardAcquireQueryLease(ctx, dashboarddb.DashboardAcquireQueryLeaseParams{
		TenantNamespace: auth.tenantNamespace,
		Token:           token,
		ExpiresAt:       now.Add(quota.Query.Timeout.Duration + 5*time.Second),
		MaxConcurrent:   quota.Query.ConcurrentRequests,
	})
	if err != nil {
		return uuid.Nil, &dashboardQuotaLimitError{
			field:     "spec.dashboardQuota.query.concurrentRequests",
			message:   "dashboard query concurrency limit reached; retry when another query finishes",
			attempted: 1,
			limit:     int64(quota.Query.ConcurrentRequests),
			cause:     err,
		}
	}
	err = tx.Commit(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	return token, nil
}

func (s *Service) reserveDashboardCells(ctx context.Context, auth requestAuth, quota agentzv1alpha1.DashboardQuota, cells int64) *dashboardQuotaLimitError {
	if cells == 0 {
		return nil
	}
	now := time.Now().UTC()
	_, err := s.dashboards.DashboardReserveQueryWindow(
		ctx,
		dashboarddb.DashboardReserveQueryWindowParams{
			TenantNamespace: auth.tenantNamespace,
			SubjectID:       "*",
			WindowKind:      "hour",
			WindowStart:     now.Truncate(time.Hour),
			Calls:           0,
			Cells:           cells,
			MaxCalls:        math.MaxInt64,
			MaxCells:        quota.Query.ReturnedCellsPerHour,
		},
	)
	if err == nil {
		return nil
	}
	return &dashboardQuotaLimitError{
		field:      "spec.dashboardQuota.query.returnedCellsPerHour",
		message:    "hourly returned-cell quota reached; retry after the current hour",
		attempted:  cells,
		limit:      quota.Query.ReturnedCellsPerHour,
		retryAfter: time.Until(now.Truncate(time.Hour).Add(time.Hour)),
		cause:      err,
	}
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
		Remediation: "Return to the agent chat and ask the agent to delete and " +
			"recreate this dashboard, then publish corrected data.",
	}
}

func dashboardBucketSeconds(period time.Duration, maxPoints int32) int32 {
	required := int64(math.Ceil(period.Seconds() / float64(maxPoints)))
	intervals := [...]int64{
		1, 5, 10, 30, 60, 300, 900,
		1800, 3600, 10800, 21600, 43200, 86400,
	}
	for _, interval := range intervals {
		if required <= interval {
			return int32(interval)
		}
	}
	return 86400
}

func dashboardRequestState(w http.ResponseWriter, r *http.Request) (requestAuth, agentzv1alpha1.DashboardQuota, bool) {
	auth, ok := requestAuthState(r.Context())
	if !ok || auth.tenantNamespace == "" || auth.workspaceID == "" {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing dashboard request scope",
			errBadRequest,
		))
		return requestAuth{}, agentzv1alpha1.DashboardQuota{}, false
	}
	tenant, err := tenantObject(r.Context())
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("dashboard quota is unavailable: %w", err))
		return requestAuth{}, agentzv1alpha1.DashboardQuota{}, false
	}
	if tenant.Spec.DashboardQuota == nil {
		writeInternalError(w, r, errors.New("tenant dashboard quota is not configured"))
		return requestAuth{}, agentzv1alpha1.DashboardQuota{}, false
	}
	return auth, *tenant.Spec.DashboardQuota, true
}

func validateDashboard(req gatewayapi.CreateDashboardRequest, maxWidgets int32) error {
	if len(validation.IsDNS1123Label(req.Name)) != 0 {
		return errors.New("name must be a DNS label")
	}
	titleLength := utf8.RuneCountInString(req.Title)
	if titleLength < 1 || titleLength > 80 {
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
		err := validateDashboardWidget(widget)
		if err != nil {
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
	titleLength := utf8.RuneCountInString(widget.Title)
	if titleLength < 1 || titleLength > 80 {
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
		labelLength := utf8.RuneCountInString(series.Label)
		if labelLength < 1 || labelLength > 80 {
			return fmt.Errorf("series[%d].label must contain 1-80 characters", i)
		}
		switch series.Aggregation {
		case gatewayapi.Sum, gatewayapi.Average, gatewayapi.Minimum,
			gatewayapi.Maximum, gatewayapi.Last, gatewayapi.Count:
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
		labelLength := utf8.RuneCountInString(column.Label)
		if labelLength < 1 || labelLength > 80 {
			return fmt.Errorf("columns[%d].label must contain 1-80 characters", i)
		}
		switch column.Type {
		case gatewayapi.DashboardTableColumnTypeText,
			gatewayapi.DashboardTableColumnTypeNumber,
			gatewayapi.DashboardTableColumnTypeBoolean,
			gatewayapi.DashboardTableColumnTypeDatetime:
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
	case gatewayapi.Funnel, gatewayapi.HorizontalFunnel:
		if widget.Mode != gatewayapi.Latest || seriesCount != 1 || columnCount != 0 {
			return errors.New("funnel charts require latest mode, one series, and no columns")
		}
	case gatewayapi.Sankey:
		if widget.Mode != gatewayapi.Latest || seriesCount != 1 || columnCount != 0 {
			return errors.New("sankey charts require latest mode, one series, and no columns")
		}
	case gatewayapi.Gauge:
		hasRange := widget.Minimum != nil && widget.Maximum != nil
		validRange := hasRange && *widget.Minimum < *widget.Maximum
		if widget.Mode != gatewayapi.Latest || seriesCount != 1 ||
			columnCount != 0 || !validRange {
			return errors.New("gauges require latest mode, one series, no columns, and an increasing range")
		}
		previous := *widget.Minimum
		for i, threshold := range widget.Thresholds {
			inRange := threshold.Value >= *widget.Minimum &&
				threshold.Value <= *widget.Maximum
			increasing := i == 0 || threshold.Value > previous
			if !inRange || !increasing {
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
		if widget.Axes == nil || seriesCount == 0 || seriesCount > 5 || columnCount != 0 {
			return errors.New("scatter plots require axes, 1-5 series, and no columns")
		}
		if utf8.RuneCountInString(widget.Axes.X.Label) < 1 ||
			utf8.RuneCountInString(widget.Axes.X.Label) > 80 {
			return errors.New("axes.x.label must contain 1-80 characters")
		}
		if widget.Axes.X.Unit != nil &&
			(utf8.RuneCountInString(*widget.Axes.X.Unit) < 1 ||
				utf8.RuneCountInString(*widget.Axes.X.Unit) > 32) {
			return errors.New("axes.x.unit must contain 1-32 characters")
		}
		if utf8.RuneCountInString(widget.Axes.Y.Label) < 1 ||
			utf8.RuneCountInString(widget.Axes.Y.Label) > 80 {
			return errors.New("axes.y.label must contain 1-80 characters")
		}
		if widget.Axes.Y.Unit != nil &&
			(utf8.RuneCountInString(*widget.Axes.Y.Unit) < 1 ||
				utf8.RuneCountInString(*widget.Axes.Y.Unit) > 32) {
			return errors.New("axes.y.unit must contain 1-32 characters")
		}
	case gatewayapi.Table:
		if columnCount == 0 || columnCount > 12 || seriesCount != 0 {
			return errors.New("tables require 1-12 columns and no series")
		}
	default:
		return fmt.Errorf("unsupported widget kind %q", widget.Kind)
	}
	hasGaugeFields := widget.Minimum != nil || widget.Maximum != nil ||
		len(widget.Thresholds) != 0
	if widget.Kind != gatewayapi.Gauge && hasGaugeFields {
		return errors.New("only gauges may declare a range or thresholds")
	}
	if widget.Kind != gatewayapi.Scatter && widget.Axes != nil {
		return errors.New("only scatter plots may declare axes")
	}
	return nil
}

func validateDashboardRecords(widget gatewayapi.DashboardWidgetDefinition, records []gatewayapi.DashboardDataRecord, receivedAt time.Time) error {
	if widget.Kind == gatewayapi.Gauge && len(records) != 1 {
		return errors.New("gauges require exactly one record")
	}
	for i, record := range records {
		err := validateDashboardRecord(widget, record, receivedAt)
		if err != nil {
			return fmt.Errorf("records[%d]: %w", i, err)
		}
	}
	if widget.Kind == gatewayapi.Funnel || widget.Kind == gatewayapi.HorizontalFunnel {
		stages := make(map[string]struct{}, len(records))
		previous := math.Inf(1)
		for i, record := range records {
			_, exists := stages[*record.Category]
			if exists {
				return fmt.Errorf("records[%d]: category is duplicated", i)
			}
			stages[*record.Category] = struct{}{}
			if (*record.Values)[0] > previous {
				return fmt.Errorf("records[%d]: funnel values must not increase", i)
			}
			previous = (*record.Values)[0]
		}
	}
	if widget.Kind != gatewayapi.Sankey {
		return nil
	}

	edges := make(map[string]map[string]struct{}, len(records))
	indegree := make(map[string]int, len(records)+1)
	for i, record := range records {
		targets := edges[*record.Source]
		if targets == nil {
			targets = map[string]struct{}{}
			edges[*record.Source] = targets
		}
		_, exists := targets[*record.Target]
		if exists {
			return fmt.Errorf("records[%d]: source and target pair is duplicated", i)
		}
		targets[*record.Target] = struct{}{}
		indegree[*record.Target]++
		_, exists = indegree[*record.Source]
		if !exists {
			indegree[*record.Source] = 0
		}
	}
	queue := make([]string, 0, len(indegree))
	for node, degree := range indegree {
		if degree == 0 {
			queue = append(queue, node)
		}
	}
	visited := 0
	for next := 0; next < len(queue); next++ {
		node := queue[next]
		visited++
		for target := range edges[node] {
			indegree[target]--
			if indegree[target] == 0 {
				queue = append(queue, target)
			}
		}
	}
	if visited != len(indegree) {
		return errors.New("sankey links must form an acyclic graph")
	}
	return nil
}

func validateDashboardRecord(widget gatewayapi.DashboardWidgetDefinition, record gatewayapi.DashboardDataRecord, receivedAt time.Time) error {
	hasFlow := record.Source != nil || record.Target != nil || record.Value != nil
	if widget.Mode == gatewayapi.Temporal {
		if record.RecordedAt == nil {
			return errors.New("recorded_at is required for temporal widgets")
		}
		if record.RecordedAt.Before(receivedAt.Add(-dashboardRetention)) {
			return errors.New("recorded_at is outside the retained period")
		}
		if record.RecordedAt.After(receivedAt.Add(dashboardFutureSkew)) {
			return errors.New("recorded_at is too far in the future")
		}
	}
	if widget.Mode == gatewayapi.Latest && record.RecordedAt != nil {
		return errors.New("recorded_at is forbidden for latest widgets")
	}

	switch widget.Kind {
	case gatewayapi.Line, gatewayapi.Area, gatewayapi.Step, gatewayapi.Gauge:
		valuesMatch := record.Values != nil &&
			len(*record.Values) == len(widget.Series)
		onlyValues := record.Category == nil &&
			record.Cells == nil &&
			record.Series == nil &&
			record.X == nil &&
			record.Y == nil &&
			record.Label == nil &&
			!hasFlow
		if valuesMatch && onlyValues {
			return nil
		}
		expected := "values only"
		if widget.Mode == gatewayapi.Temporal {
			expected = "recorded_at and values only"
		}
		return fmt.Errorf(
			"expected %s, with one value for each of %d series",
			expected,
			len(widget.Series),
		)
	case gatewayapi.Pie, gatewayapi.Bar, gatewayapi.HorizontalGroupedBar,
		gatewayapi.Funnel, gatewayapi.HorizontalFunnel:
		valuesMatch := record.Values != nil &&
			len(*record.Values) == len(widget.Series)
		onlyCategoryValues := record.Cells == nil &&
			record.Series == nil &&
			record.X == nil &&
			record.Y == nil &&
			record.Label == nil &&
			!hasFlow
		if record.Category == nil || !valuesMatch || !onlyCategoryValues {
			expected := "category and values only"
			if widget.Mode == gatewayapi.Temporal {
				expected = "recorded_at, category, and values only"
			}
			return fmt.Errorf(
				"expected %s, with one value for each of %d series",
				expected,
				len(widget.Series),
			)
		}
		categoryLength := utf8.RuneCountInString(*record.Category)
		if categoryLength < 1 || categoryLength > 120 {
			return errors.New("category must contain 1-120 characters")
		}
		isFunnel := widget.Kind == gatewayapi.Funnel ||
			widget.Kind == gatewayapi.HorizontalFunnel
		if isFunnel && (*record.Values)[0] < 0 {
			return errors.New("funnel values must not be negative")
		}
		return nil
	case gatewayapi.Sankey:
		onlyFlow := record.Category == nil &&
			record.Values == nil &&
			record.Cells == nil &&
			record.Series == nil &&
			record.X == nil &&
			record.Y == nil &&
			record.Label == nil
		if record.Source == nil || record.Target == nil ||
			record.Value == nil || !onlyFlow {
			return errors.New("expected source, target, and value only")
		}
		sourceLength := utf8.RuneCountInString(*record.Source)
		if sourceLength < 1 || sourceLength > 120 {
			return errors.New("source must contain 1-120 characters")
		}
		targetLength := utf8.RuneCountInString(*record.Target)
		if targetLength < 1 || targetLength > 120 {
			return errors.New("target must contain 1-120 characters")
		}
		if *record.Source == *record.Target {
			return errors.New("source and target must differ")
		}
		if *record.Value <= 0 {
			return errors.New("value must be positive")
		}
		return nil
	case gatewayapi.Scatter:
		seriesMatches := record.Series != nil &&
			*record.Series >= 0 &&
			int(*record.Series) < len(widget.Series)
		onlyScatter := record.Category == nil &&
			record.Values == nil &&
			record.Cells == nil &&
			!hasFlow
		if record.X == nil || record.Y == nil ||
			!seriesMatches || !onlyScatter {
			expected := "series, x, y, and optional label only"
			if widget.Mode == gatewayapi.Temporal {
				expected = "recorded_at, series, x, y, and optional label only"
			}
			return fmt.Errorf("expected %s", expected)
		}
		if record.Label == nil {
			return nil
		}
		labelLength := utf8.RuneCountInString(*record.Label)
		if labelLength < 1 || labelLength > 120 {
			return errors.New("label must contain 1-120 characters")
		}
		return nil
	case gatewayapi.Table:
		cellsMatch := record.Cells != nil &&
			len(*record.Cells) == len(widget.Columns)
		onlyCells := record.Category == nil &&
			record.Values == nil &&
			record.Series == nil &&
			record.X == nil &&
			record.Y == nil &&
			record.Label == nil &&
			!hasFlow
		if !cellsMatch || !onlyCells {
			expected := "cells only"
			if widget.Mode == gatewayapi.Temporal {
				expected = "recorded_at and cells only"
			}
			return fmt.Errorf(
				"expected %s, with one cell for each of %d columns",
				expected,
				len(widget.Columns),
			)
		}
		for i, cell := range *record.Cells {
			if !dashboardCellMatches(widget.Columns[i].Type, cell) {
				return fmt.Errorf(
					"cell %d does not match column type %q",
					i,
					widget.Columns[i].Type,
				)
			}
			if cell.Text != nil &&
				utf8.RuneCountInString(*cell.Text) > 1024 {
				return fmt.Errorf(
					"cell %d text contains more than 1024 characters",
					i,
				)
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported widget kind %q", widget.Kind)
	}
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
