package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	auditRetention         = 30 * 24 * time.Hour
	auditRetentionInterval = 24 * time.Hour
)

type auditCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

// ListAuditEvents handles GET /api/audit-event.
func (s *Service) ListAuditEvents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListAuditEventsParams) {
	claims, authErr := s.authorizeAuditRead(r.Context())
	if authErr != nil {
		writeError(w, r, authErr)
		return
	}

	pageSize := int32(50)
	if params.Limit != nil {
		pageSize = *params.Limit
	}
	retainedAfter := time.Now().Add(-auditRetention)
	query := gatewaydb.GatewayListAuditEventsParams{
		OrganizationID: claims.TenantID,
		RetainedAfter: pgtype.Timestamptz{
			Time:  retainedAfter,
			Valid: true,
		},
		PageSize: pageSize + 1,
	}
	if params.ActorType != nil {
		query.ActorType = gatewaydb.NullAuditActor{
			AuditActor: gatewaydb.AuditActor(*params.ActorType),
			Valid:      true,
		}
	}
	if params.ActorId != nil {
		query.ActorID = pgtype.Text{String: *params.ActorId, Valid: true}
	}
	if params.Category != nil {
		query.Category = pgtype.Text{String: *params.Category, Valid: true}
	}
	if params.WorkspaceId != nil {
		query.WorkspaceID = pgtype.Text{String: *params.WorkspaceId, Valid: true}
	}
	if params.TargetType != nil {
		query.TargetType = gatewaydb.NullAuditTarget{
			AuditTarget: gatewaydb.AuditTarget(*params.TargetType),
			Valid:       true,
		}
	}
	if params.Result != nil {
		query.Result = gatewaydb.NullAuditResult{
			AuditResult: gatewaydb.AuditResult(*params.Result),
			Valid:       true,
		}
	}
	if params.CreatedAfter != nil {
		query.CreatedAfter = pgtype.Timestamptz{
			Time:  *params.CreatedAfter,
			Valid: true,
		}
	}
	if params.CreatedBefore != nil {
		query.CreatedBefore = pgtype.Timestamptz{
			Time:  *params.CreatedBefore,
			Valid: true,
		}
	}
	if params.CreatedAfter != nil && params.CreatedBefore != nil &&
		params.CreatedAfter.After(*params.CreatedBefore) {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"created_after must not be later than created_before",
			errors.New("invalid audit date range"),
		))
		return
	}
	cursor, cursorSet, ok := decodeCursorPageToken[auditCursor](w, r, params.PageToken)
	if !ok {
		return
	}
	if cursorSet {
		if cursor.CreatedAt.IsZero() || cursor.ID == "" {
			writeInvalidPageToken(w, r, errors.New("invalid audit cursor"))
			return
		}
		query.CursorSet = true
		query.CursorCreatedAt = cursor.CreatedAt
		query.CursorID = cursor.ID
	}

	rows, err := s.queries.GatewayListAuditEvents(r.Context(), query)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list audit events: %w", err))
		return
	}

	nextPageToken := ""
	if len(rows) > int(pageSize) {
		rows = rows[:pageSize]
		last := rows[len(rows)-1]
		nextPageToken = encodeCursorPageToken(auditCursor{
			CreatedAt: last.CreatedAt.Time,
			ID:        last.ID,
		})
	}

	events := make([]gatewayapi.AuditEvent, 0, len(rows))
	for _, row := range rows {
		event, viewErr := auditEventView(row)
		if viewErr != nil {
			writeInternalError(w, r, viewErr)
			return
		}
		events = append(events, event)
	}

	filters, err := s.auditFilters(r.Context(), claims.TenantID, retainedAfter)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, gatewayapi.ListAuditEventsResponse{
		Events:        events,
		Filters:       filters,
		NextPageToken: nextPageToken,
	})
}

// GetAuditEvent handles GET /api/audit-event/{eventId}.
func (s *Service) GetAuditEvent(w http.ResponseWriter, r *http.Request, eventID gatewayapi.AuditEventIDPath) {
	claims, authErr := s.authorizeAuditRead(r.Context())
	if authErr != nil {
		writeError(w, r, authErr)
		return
	}

	rows, err := s.queries.GatewayListAuditEvents(
		r.Context(),
		gatewaydb.GatewayListAuditEventsParams{
			OrganizationID: claims.TenantID,
			RetainedAfter: pgtype.Timestamptz{
				Time:  time.Now().Add(-auditRetention),
				Valid: true,
			},
			EventID:  pgtype.Text{String: eventID, Valid: true},
			PageSize: 1,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get audit event: %w", err))
		return
	}
	if len(rows) == 0 {
		writeError(w, r, newAPIError(
			http.StatusNotFound,
			"audit_event_not_found",
			"audit event was not found",
			fmt.Errorf("audit event %q was not found", eventID),
		))
		return
	}

	event, err := auditEventView(rows[0])
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, event)
}

func (s *Service) authorizeAuditRead(ctx context.Context) (gatewayClaims, *apiError) {
	auth, ok := requestAuthState(ctx)
	if !ok || auth.claims == nil {
		return gatewayClaims{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		)
	}

	allowed, err := s.queries.GatewayIsActiveSuperadmin(
		ctx,
		gatewaydb.GatewayIsActiveSuperadminParams{
			UserID:         auth.claims.UserID,
			OrganizationID: auth.claims.TenantID,
		},
	)
	if err != nil {
		return gatewayClaims{}, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("authorize audit read: %w", err),
		)
	}
	if !allowed {
		return gatewayClaims{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"Superadmin authority is required",
			fmt.Errorf("user %q is not a Superadmin", auth.claims.UserID),
		)
	}

	return *auth.claims, nil
}

func (s *Service) auditFilters(ctx context.Context, organizationID string, retainedAfter time.Time) (gatewayapi.AuditFilters, error) {
	retention := pgtype.Timestamptz{Time: retainedAfter, Valid: true}
	actors, err := s.queries.GatewayListAuditActors(
		ctx,
		gatewaydb.GatewayListAuditActorsParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
		},
	)
	if err != nil {
		return gatewayapi.AuditFilters{}, fmt.Errorf("list audit actors: %w", err)
	}
	categories, err := s.queries.GatewayListAuditCategories(
		ctx,
		gatewaydb.GatewayListAuditCategoriesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
		},
	)
	if err != nil {
		return gatewayapi.AuditFilters{}, fmt.Errorf("list audit categories: %w", err)
	}
	workspaces, err := s.queries.GatewayListAuditWorkspaces(
		ctx,
		gatewaydb.GatewayListAuditWorkspacesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
		},
	)
	if err != nil {
		return gatewayapi.AuditFilters{}, fmt.Errorf("list audit workspaces: %w", err)
	}
	targetTypes, err := s.queries.GatewayListAuditTargetTypes(
		ctx,
		gatewaydb.GatewayListAuditTargetTypesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
		},
	)
	if err != nil {
		return gatewayapi.AuditFilters{}, fmt.Errorf("list audit target types: %w", err)
	}

	actorFilters := make([]gatewayapi.AuditActorFilter, 0, len(actors))
	for _, actor := range actors {
		name := actor.ActorName
		filter := gatewayapi.AuditActorFilter{
			Name: &name,
			Type: gatewayapi.AuditActorType(actor.ActorType),
		}
		if actor.ActorID.Valid {
			id := actor.ActorID.String
			filter.Id = &id
		}
		if actor.ActorEmail.Valid {
			email := openapi_types.Email(actor.ActorEmail.String)
			filter.Email = &email
		}
		actorFilters = append(actorFilters, filter)
	}

	workspaceFilters := make([]gatewayapi.AuditWorkspaceFilter, 0, len(workspaces))
	for _, workspace := range workspaces {
		filter := gatewayapi.AuditWorkspaceFilter{Id: workspace.WorkspaceID.String}
		if workspace.Name.Valid {
			name := workspace.Name.String
			filter.Name = &name
		}
		if workspace.Slug.Valid {
			slug := workspace.Slug.String
			filter.Slug = &slug
		}
		workspaceFilters = append(workspaceFilters, filter)
	}

	targetTypeFilters := make([]gatewayapi.AuditTargetType, 0, len(targetTypes))
	for _, targetType := range targetTypes {
		targetTypeFilters = append(
			targetTypeFilters,
			gatewayapi.AuditTargetType(targetType),
		)
	}

	return gatewayapi.AuditFilters{
		Actors:      actorFilters,
		Categories:  categories,
		TargetTypes: targetTypeFilters,
		Workspaces:  workspaceFilters,
	}, nil
}

func auditEventView(row gatewaydb.GatewayListAuditEventsRow) (gatewayapi.AuditEvent, error) {
	before := []gatewayapi.AuditField{}
	if len(row.Before) > 0 {
		if err := json.Unmarshal(row.Before, &before); err != nil {
			return gatewayapi.AuditEvent{}, fmt.Errorf("decode audit event %q before summary: %w", row.ID, err)
		}
	}
	after := []gatewayapi.AuditField{}
	if len(row.After) > 0 {
		if err := json.Unmarshal(row.After, &after); err != nil {
			return gatewayapi.AuditEvent{}, fmt.Errorf("decode audit event %q after summary: %w", row.ID, err)
		}
	}

	actorName := row.ActorName
	actor := gatewayapi.AuditActor{
		Name: &actorName,
		Type: gatewayapi.AuditActorType(row.ActorType),
	}
	if row.ActorID.Valid {
		actorID := row.ActorID.String
		actor.Id = &actorID
	}
	if row.ActorEmail.Valid {
		email := openapi_types.Email(row.ActorEmail.String)
		actor.Email = &email
	}

	targetName := row.TargetName
	target := gatewayapi.AuditTarget{
		Id:   row.TargetID,
		Name: &targetName,
		Type: gatewayapi.AuditTargetType(row.TargetType),
	}
	if row.TargetSlug != "" {
		targetSlug := row.TargetSlug
		target.Slug = &targetSlug
	}

	event := gatewayapi.AuditEvent{
		Action:           row.Action,
		Actor:            actor,
		After:            after,
		AutomaticCascade: row.AutomaticCascade,
		Before:           before,
		Category:         row.Category,
		CreatedAt:        row.CreatedAt.Time,
		Id:               row.ID,
		Interface:        gatewayapi.AuditInterface(row.Interface),
		Result:           gatewayapi.AuditResult(row.Result),
		Target:           target,
	}
	if row.IpAddress.Valid {
		ipAddress := row.IpAddress.String
		event.IpAddress = &ipAddress
	}
	if row.UserAgent.Valid {
		userAgent := row.UserAgent.String
		event.UserAgent = &userAgent
	}
	if row.WorkspaceID.Valid {
		workspace := gatewayapi.AuditWorkspace{Id: row.WorkspaceID.String}
		if row.WorkspaceName.Valid {
			name := row.WorkspaceName.String
			workspace.Name = &name
		}
		if row.WorkspaceSlug.Valid {
			slug := row.WorkspaceSlug.String
			workspace.Slug = &slug
		}
		event.Workspace = &workspace
	}
	if row.CleanupJobID.Valid && row.CleanupState.Valid {
		cleanup := gatewayapi.AuditCleanup{
			Id:    row.CleanupJobID.String,
			State: gatewayapi.AuditCleanupState(row.CleanupState.CleanupState),
		}
		if row.CleanupCompletedAt.Valid {
			cleanup.CompletedAt = &row.CleanupCompletedAt.Time
		}
		event.Cleanup = &cleanup
	}

	return event, nil
}

func (s *Service) runAuditRetention(ctx context.Context) {
	ticker := time.NewTicker(auditRetentionInterval)
	defer ticker.Stop()

	for {
		deleted, err := s.queries.GatewayDeleteExpiredAuditEvents(
			ctx,
			pgtype.Timestamptz{
				Time:  time.Now().Add(-auditRetention),
				Valid: true,
			},
		)
		if err != nil {
			slog.ErrorContext(ctx, "delete expired audit events", slog.Any("err", err))
		} else if deleted > 0 {
			slog.InfoContext(ctx, "deleted expired audit events", slog.Int64("count", deleted))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
