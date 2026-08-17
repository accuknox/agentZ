package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

const (
	eventTrailRetention         = 30 * 24 * time.Hour
	eventTrailRetentionInterval = 24 * time.Hour
)

type eventTrailCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

type eventTrailAccess struct {
	organizationID string
	workspaceID    pgtype.Text
}

type eventTrailClause struct {
	actorTypes    []string
	actorIDs      []string
	categories    []string
	workspaceIDs  []string
	targetTypes   []string
	results       []string
	createdAfter  pgtype.Timestamptz
	createdBefore pgtype.Timestamptz
}

// ListEventTrailEvents handles POST /api/event-trail-event.
func (s *Service) ListEventTrailEvents(w http.ResponseWriter, r *http.Request, params gatewayapi.ListEventTrailEventsParams) {
	var req gatewayapi.ListEventTrailEventsRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}
	if req.Limit < 1 || req.Limit > 100 {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"limit must be between 1 and 100",
				errors.New("invalid event trail page size"),
			),
		)
		return
	}
	clause, err := compileEventTrailFilters(req.Filters)
	if err != nil {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				err.Error(),
				err,
			),
		)
		return
	}

	var workspaceID string
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, authErr := s.authorizeEventTrailRead(r.Context(), workspaceID)
	if authErr != nil {
		writeError(w, r, authErr)
		return
	}
	if access.workspaceID.Valid && len(clause.workspaceIDs) > 0 {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusBadRequest,
				"invalid_request",
				"workspace_id cannot filter a Workspace-scoped request",
				errors.New("workspace filter duplicates the authorized scope"),
			),
		)
		return
	}

	pageSize := req.Limit
	retainedAfter := time.Now().Add(-eventTrailRetention)
	cursor, cursorSet, ok := decodeCursorPageToken[eventTrailCursor](w, r, req.PageToken)
	if !ok {
		return
	}
	if cursorSet {
		if cursor.CreatedAt.IsZero() || cursor.ID == "" {
			writeInvalidPageToken(w, r, errors.New("invalid event trail cursor"))
			return
		}
	}

	query := gatewaydb.GatewayListEventTrailEventsParams{
		OrganizationID:   access.organizationID,
		RetainedAfter:    pgtype.Timestamptz{Time: retainedAfter, Valid: true},
		ScopeWorkspaceID: access.workspaceID,
		ActorTypes:       clause.actorTypes,
		ActorIds:         clause.actorIDs,
		Categories:       clause.categories,
		WorkspaceIds:     clause.workspaceIDs,
		TargetTypes:      clause.targetTypes,
		Results:          clause.results,
		CreatedAfter:     clause.createdAfter,
		CreatedBefore:    clause.createdBefore,
		CursorSet:        cursorSet,
		CursorCreatedAt:  cursor.CreatedAt,
		CursorID:         cursor.ID,
		PageSize:         pageSize + 1,
	}
	rows, err := s.queries.GatewayListEventTrailEvents(r.Context(), query)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list event trail events: %w", err))
		return
	}

	var nextPageToken string
	if len(rows) > int(pageSize) {
		rows = rows[:pageSize]
		last := rows[len(rows)-1]
		nextPageToken = encodeCursorPageToken(eventTrailCursor{
			CreatedAt: last.CreatedAt.Time,
			ID:        last.ID,
		})
	}

	events := make([]gatewayapi.EventTrailEvent, 0, len(rows))
	for _, row := range rows {
		event, viewErr := eventTrailEventView(row)
		if viewErr != nil {
			writeInternalError(w, r, viewErr)
			return
		}
		events = append(events, event)
	}

	filters, err := s.eventTrailFilters(
		r.Context(),
		access.organizationID,
		access.workspaceID,
		retainedAfter,
	)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	writeJSON(
		w,
		http.StatusOK,
		gatewayapi.ListEventTrailEventsResponse{
			Events:        events,
			FilterOptions: filters,
			NextPageToken: nextPageToken,
		},
	)
}

// GetEventTrailEvent handles GET /api/event-trail-event/{eventId}.
func (s *Service) GetEventTrailEvent(w http.ResponseWriter, r *http.Request, eventID gatewayapi.EventTrailEventIDPath, params gatewayapi.GetEventTrailEventParams) {
	var workspaceID string
	if params.XAgentZWorkspaceID != nil {
		workspaceID = *params.XAgentZWorkspaceID
	}
	access, authErr := s.authorizeEventTrailRead(r.Context(), workspaceID)
	if authErr != nil {
		writeError(w, r, authErr)
		return
	}

	rows, err := s.queries.GatewayListEventTrailEvents(
		r.Context(),
		gatewaydb.GatewayListEventTrailEventsParams{
			OrganizationID:   access.organizationID,
			ScopeWorkspaceID: access.workspaceID,
			RetainedAfter: pgtype.Timestamptz{
				Time:  time.Now().Add(-eventTrailRetention),
				Valid: true,
			},
			EventID:  pgtype.Text{String: eventID, Valid: true},
			PageSize: 1,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get event trail event: %w", err))
		return
	}
	if len(rows) == 0 {
		writeError(
			w,
			r,
			newAPIError(
				http.StatusNotFound,
				"event_trail_event_not_found",
				"event trail event was not found",
				fmt.Errorf("event trail event %q was not found", eventID),
			),
		)
		return
	}

	event, err := eventTrailEventView(rows[0])
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, event)
}

func compileEventTrailFilters(filters []gatewayapi.EventTrailFilter) (eventTrailClause, error) {
	if len(filters) > 7 {
		return eventTrailClause{}, errors.New("event trail supports at most seven filters")
	}

	clause := eventTrailClause{}
	fields := make(map[gatewayapi.EventTrailFilterField]struct{}, len(filters))
	for _, filter := range filters {
		if _, exists := fields[filter.Field]; exists {
			return eventTrailClause{}, fmt.Errorf("duplicate event trail filter field %q", filter.Field)
		}
		fields[filter.Field] = struct{}{}
		values := filter.Values
		if len(values) == 0 {
			return eventTrailClause{}, errors.New("event trail filters require at least one value")
		}
		if len(values) > 100 {
			return eventTrailClause{}, errors.New("event trail filters support at most one hundred values")
		}
		for _, value := range values {
			if value == "" || len(value) > 256 {
				return eventTrailClause{}, errors.New(
					"event trail filter values must contain 1 to 256 characters",
				)
			}
		}

		if filter.Field == gatewayapi.CreatedAt {
			if len(values) != 2 {
				return eventTrailClause{}, errors.New("created_at requires exactly two timestamps")
			}
			from, err := time.Parse(time.RFC3339, values[0])
			if err != nil {
				return eventTrailClause{}, errors.New("event trail timestamps must use RFC 3339")
			}
			to, parseErr := time.Parse(time.RFC3339, values[1])
			if parseErr != nil {
				return eventTrailClause{}, errors.New("event trail timestamps must use RFC 3339")
			}
			if from.After(to) {
				return eventTrailClause{}, errors.New("event trail date range starts after it ends")
			}
			clause.createdAfter = pgtype.Timestamptz{Time: from, Valid: true}
			clause.createdBefore = pgtype.Timestamptz{Time: to, Valid: true}
			continue
		}

		switch filter.Field {
		case gatewayapi.ActorType:
			for _, value := range values {
				actorType := gatewayapi.EventTrailActorType(value)
				switch actorType {
				case gatewayapi.EventTrailActorTypeUser,
					gatewayapi.EventTrailActorTypeApiKey,
					gatewayapi.EventTrailActorTypeSystem:
				default:
					return eventTrailClause{}, fmt.Errorf("invalid actor type %q", value)
				}
			}
			clause.actorTypes = values
		case gatewayapi.ActorId:
			clause.actorIDs = values
		case gatewayapi.Category:
			clause.categories = values
		case gatewayapi.WorkspaceId:
			clause.workspaceIDs = values
		case gatewayapi.TargetType:
			for _, value := range values {
				targetType := gatewayapi.EventTrailTargetType(value)
				switch targetType {
				case gatewayapi.EventTrailTargetOrganization,
					gatewayapi.EventTrailTargetOrganizationMembership,
					gatewayapi.EventTrailTargetTeam,
					gatewayapi.EventTrailTargetMCPConnection,
					gatewayapi.EventTrailTargetInferenceProvider,
					gatewayapi.EventTrailTargetInferencePool,
					gatewayapi.EventTrailTargetRole,
					gatewayapi.EventTrailTargetSandbox,
					gatewayapi.EventTrailTargetSkill,
					gatewayapi.EventTrailTargetAgent,
					gatewayapi.EventTrailTargetWorkspace:
				default:
					return eventTrailClause{}, fmt.Errorf("invalid target type %q", value)
				}
			}
			clause.targetTypes = values
		case gatewayapi.Result:
			for _, value := range values {
				result := gatewayapi.EventTrailResult(value)
				switch result {
				case gatewayapi.EventTrailResultSucceeded,
					gatewayapi.EventTrailResultDenied,
					gatewayapi.EventTrailResultFailed:
				default:
					return eventTrailClause{}, fmt.Errorf("invalid result %q", value)
				}
			}
			clause.results = values
		default:
			return eventTrailClause{}, errors.New("unsupported event trail filter field")
		}
	}
	return clause, nil
}

func (s *Service) authorizeEventTrailRead(ctx context.Context, workspaceID string) (eventTrailAccess, *apiError) {
	auth, ok := requestAuthState(ctx)
	if !ok || auth.claims == nil {
		return eventTrailAccess{}, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing bearer claims",
			errors.New("missing bearer claims"),
		)
	}
	if auth.claims.WorkspaceID != workspaceID {
		return eventTrailAccess{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"request is not authorized for the selected scope",
			errors.New("selected Workspace does not match bearer claims"),
		)
	}

	effective, err := authorization.New(s.queries).Resolve(
		ctx,
		authorization.Subject{
			UserID:         auth.claims.UserID,
			OrganizationID: auth.claims.OrganizationID,
		},
	)
	if err != nil {
		return eventTrailAccess{}, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"unexpected server error",
			fmt.Errorf("authorize event trail read: %w", err),
		)
	}
	allowed := effective.CanAdminister(authorization.Scope{
		OrganizationID: auth.claims.OrganizationID,
		WorkspaceID:    workspaceID,
	})
	if !allowed {
		return eventTrailAccess{}, newAPIError(
			http.StatusForbidden,
			"forbidden",
			"administrative authority is required for the selected scope",
			fmt.Errorf("user %q cannot administer the selected event trail scope", auth.claims.UserID),
		)
	}
	if workspaceID != "" {
		workspace, err := s.queries.GatewayGetWorkspace(
			ctx,
			gatewaydb.GatewayGetWorkspaceParams{
				ID:             workspaceID,
				OrganizationID: auth.claims.OrganizationID,
			},
		)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && workspace.DeletedAt.Valid) {
			return eventTrailAccess{}, newAPIError(
				http.StatusForbidden,
				"forbidden",
				"request is not authorized for the selected scope",
				errors.New("selected Workspace is not active"),
			)
		}
		if err != nil {
			return eventTrailAccess{}, newAPIError(
				http.StatusInternalServerError,
				"internal_error",
				"unexpected server error",
				fmt.Errorf("resolve event trail Workspace: %w", err),
			)
		}
	}

	access := eventTrailAccess{organizationID: auth.claims.OrganizationID}
	if workspaceID != "" {
		access.workspaceID = pgtype.Text{String: workspaceID, Valid: true}
	}
	return access, nil
}

func (s *Service) eventTrailFilters(ctx context.Context, organizationID string, workspaceID pgtype.Text, retainedAfter time.Time) (gatewayapi.EventTrailFilters, error) {
	retention := pgtype.Timestamptz{Time: retainedAfter, Valid: true}
	actors, err := s.queries.GatewayListEventTrailActors(
		ctx,
		gatewaydb.GatewayListEventTrailActorsParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
			WorkspaceID:    workspaceID,
		},
	)
	if err != nil {
		return gatewayapi.EventTrailFilters{}, fmt.Errorf("list event trail actors: %w", err)
	}
	categories, err := s.queries.GatewayListEventTrailCategories(
		ctx,
		gatewaydb.GatewayListEventTrailCategoriesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
			WorkspaceID:    workspaceID,
		},
	)
	if err != nil {
		return gatewayapi.EventTrailFilters{}, fmt.Errorf("list event trail categories: %w", err)
	}
	workspaces, err := s.queries.GatewayListEventTrailWorkspaces(
		ctx,
		gatewaydb.GatewayListEventTrailWorkspacesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
			WorkspaceID:    workspaceID,
		},
	)
	if err != nil {
		return gatewayapi.EventTrailFilters{}, fmt.Errorf("list event trail workspaces: %w", err)
	}
	targetTypes, err := s.queries.GatewayListEventTrailTargetTypes(
		ctx,
		gatewaydb.GatewayListEventTrailTargetTypesParams{
			OrganizationID: organizationID,
			RetainedAfter:  retention,
			WorkspaceID:    workspaceID,
		},
	)
	if err != nil {
		return gatewayapi.EventTrailFilters{}, fmt.Errorf("list event trail target types: %w", err)
	}

	actorFilters := make([]gatewayapi.EventTrailActorFilter, 0, len(actors))
	for _, actor := range actors {
		name := actor.ActorName
		filter := gatewayapi.EventTrailActorFilter{
			Name: &name,
			Type: gatewayapi.EventTrailActorType(actor.ActorType),
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

	workspaceFilters := make([]gatewayapi.EventTrailWorkspaceFilter, 0, len(workspaces))
	for _, workspace := range workspaces {
		filter := gatewayapi.EventTrailWorkspaceFilter{Id: workspace.WorkspaceID.String}
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

	targetTypeFilters := make([]gatewayapi.EventTrailTargetType, 0, len(targetTypes))
	for _, targetType := range targetTypes {
		targetTypeFilters = append(
			targetTypeFilters,
			gatewayapi.EventTrailTargetType(targetType),
		)
	}

	return gatewayapi.EventTrailFilters{
		Actors:      actorFilters,
		Categories:  categories,
		TargetTypes: targetTypeFilters,
		Workspaces:  workspaceFilters,
	}, nil
}

func eventTrailEventView(row gatewaydb.GatewayListEventTrailEventsRow) (gatewayapi.EventTrailEvent, error) {
	before := []gatewayapi.EventTrailField{}
	if len(row.Before) > 0 {
		if err := json.Unmarshal(row.Before, &before); err != nil {
			return gatewayapi.EventTrailEvent{}, fmt.Errorf("decode event trail event %q before summary: %w", row.ID, err)
		}
	}
	after := []gatewayapi.EventTrailField{}
	if len(row.After) > 0 {
		if err := json.Unmarshal(row.After, &after); err != nil {
			return gatewayapi.EventTrailEvent{}, fmt.Errorf("decode event trail event %q after summary: %w", row.ID, err)
		}
	}

	actorName := row.ActorName
	actor := gatewayapi.EventTrailActor{
		Name: &actorName,
		Type: gatewayapi.EventTrailActorType(row.ActorType),
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
	target := gatewayapi.EventTrailTarget{
		Id:   row.TargetID,
		Name: &targetName,
		Type: gatewayapi.EventTrailTargetType(row.TargetType),
	}
	if row.TargetSlug != "" {
		targetSlug := row.TargetSlug
		target.Slug = &targetSlug
	}

	event := gatewayapi.EventTrailEvent{
		Action:    row.Action,
		Actor:     actor,
		After:     after,
		Before:    before,
		Category:  row.Category,
		CreatedAt: row.CreatedAt.Time,
		Id:        row.ID,
		Result:    gatewayapi.EventTrailResult(row.Result),
		Target:    target,
	}
	if row.WorkspaceID.Valid {
		workspace := gatewayapi.EventTrailWorkspace{Id: row.WorkspaceID.String}
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
	return event, nil
}

func (s *Service) runEventTrailRetention(ctx context.Context) {
	ticker := time.NewTicker(eventTrailRetentionInterval)
	defer ticker.Stop()

	for {
		deleted, err := s.queries.GatewayDeleteExpiredEventTrailEvents(
			ctx,
			pgtype.Timestamptz{
				Time:  time.Now().Add(-eventTrailRetention),
				Valid: true,
			},
		)
		if err != nil {
			slog.ErrorContext(ctx, "delete expired event trail events", slog.Any("err", err))
		}
		if err == nil && deleted > 0 {
			slog.InfoContext(ctx, "deleted expired event trail events", slog.Int64("count", deleted))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
