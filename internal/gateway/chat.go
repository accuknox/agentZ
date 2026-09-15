package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

type chatSessionCursor struct {
	UpdatedAt time.Time `json:"updated_at"`
	AgentName string    `json:"agent_name"`
	SessionID string    `json:"session_id"`
}

type chatSessionGroupKey struct {
	GroupBy gatewayapi.ChatSessionGroupBy
	Value   string
}

type chatSessionEvents struct {
	mu       sync.Mutex
	watchers map[string]map[chan uint64]uint64
}

// ListChatSessions handles GET /api/chat-session.
func (s *Service) ListChatSessions(w http.ResponseWriter, r *http.Request, params gatewayapi.ListChatSessionsParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}

	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	accessibleAgentNames := usableAgentNames(nil, capabilities)
	slices.Sort(accessibleAgentNames)
	agentNames := accessibleAgentNames
	if params.AgentName != nil {
		agentNames = []string{}
		capability, ok := capabilities[*params.AgentName]
		if ok && capability.Use {
			agentNames = []string{*params.AgentName}
		}
	}
	limit := int32(10)
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 50 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 50",
			errBadRequest,
		))
		return
	}
	auth, _ := requestAuthState(r.Context())
	var ownerID pgtype.Text
	if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
		ownerID = pgtype.Text{String: access.claims.UserID, Valid: true}
	}
	groupBy := gatewayapi.ChatSessionGroupByNone
	if params.GroupBy != nil {
		groupBy = *params.GroupBy
	}
	search := ""
	if params.Search != nil {
		search = strings.TrimSpace(*params.Search)
		length := utf8.RuneCountInString(search)
		if search != "" && (length < 3 || length > 200) {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"search must contain between 3 and 200 characters",
				errBadRequest,
			))
			return
		}
	}
	if (params.ActiveAgentName == nil) != (params.ActiveSessionId == nil) {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"active_agent_name and active_session_id must be provided together",
			errBadRequest,
		))
		return
	}

	location := time.UTC
	if groupBy == gatewayapi.ChatSessionGroupByDate {
		if params.TimeZone == nil {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"time_zone is required when grouping by date",
				errBadRequest,
			))
			return
		}
		location, err = time.LoadLocation(*params.TimeZone)
		if err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"time_zone is invalid",
				err,
			))
			return
		}
	}
	now := time.Now().In(location)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	yesterday := today.AddDate(0, 0, -1)
	previousWeek := today.AddDate(0, 0, -6)

	activeGroup := ""
	if params.ActiveAgentName != nil && slices.Contains(agentNames, *params.ActiveAgentName) {
		switch groupBy {
		case gatewayapi.ChatSessionGroupByAgent:
			activeGroup = *params.ActiveAgentName
		case gatewayapi.ChatSessionGroupByStatus,
			gatewayapi.ChatSessionGroupByDate,
			gatewayapi.ChatSessionGroupByProject:
			row, getErr := s.queries.GatewayGetChatSessionGroup(
				r.Context(),
				gatewaydb.GatewayGetChatSessionGroupParams{
					WorkspaceID: access.workspaceID,
					AgentName:   *params.ActiveAgentName,
					SessionID:   *params.ActiveSessionId,
					OwnerID:     ownerID,
				},
			)
			if errors.Is(getErr, pgx.ErrNoRows) {
				break
			}
			if getErr != nil {
				apiutil.WriteInternalError(w, r, fmt.Errorf("get active chat session group: %w", getErr))
				return
			}
			switch groupBy {
			case gatewayapi.ChatSessionGroupByProject:
				activeGroup = row.ProjectID.String
			case gatewayapi.ChatSessionGroupByStatus:
				activeGroup = string(row.Status)
			case gatewayapi.ChatSessionGroupByDate:
				activeGroup = chatSessionDateGroup(
					row.SourceUpdatedAt.Time,
					today,
					yesterday,
					previousWeek,
				)
			}
		}
	}

	var projectID pgtype.Text
	if params.ProjectId != nil {
		projectID = pgtype.Text{String: *params.ProjectId, Valid: true}
	}
	var groupAgent pgtype.Text
	var groupStatus gatewaydb.NullChatSessionStatus
	var groupSince, groupBefore pgtype.Timestamptz
	groupValue := ""
	if params.GroupKey != nil {
		if groupBy == gatewayapi.ChatSessionGroupByNone {
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"group_key requires grouped results",
				errBadRequest,
			))
			return
		}
		key, decodeErr := decodeChatSessionGroupKey(*params.GroupKey)
		if decodeErr != nil || key.GroupBy != groupBy {
			if decodeErr == nil {
				decodeErr = errBadRequest
			}
			apiutil.WriteError(w, r, apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"group_key is invalid",
				decodeErr,
			))
			return
		}
		groupValue = key.Value
		switch groupBy {
		case gatewayapi.ChatSessionGroupByProject:
			projectID = pgtype.Text{String: groupValue, Valid: true}
		case gatewayapi.ChatSessionGroupByAgent:
			if !slices.Contains(accessibleAgentNames, groupValue) {
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest,
					"invalid_request",
					"group_key is invalid",
					errBadRequest,
				))
				return
			}
			groupAgent = pgtype.Text{String: groupValue, Valid: true}
		case gatewayapi.ChatSessionGroupByStatus:
			status := gatewaydb.ChatSessionStatus(groupValue)
			switch status {
			case gatewaydb.ChatSessionStatusBusy, gatewaydb.ChatSessionStatusRetry, gatewaydb.ChatSessionStatusIdle:
			default:
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest,
					"invalid_request",
					"group_key is invalid",
					errBadRequest,
				))
				return
			}
			groupStatus = gatewaydb.NullChatSessionStatus{
				ChatSessionStatus: status,
				Valid:             true,
			}
		case gatewayapi.ChatSessionGroupByDate:
			switch gatewayapi.ChatSessionDateBucket(groupValue) {
			case gatewayapi.ChatSessionDateBucketToday:
				groupSince = pgtype.Timestamptz{Time: today, Valid: true}
			case gatewayapi.ChatSessionDateBucketYesterday:
				groupSince = pgtype.Timestamptz{Time: yesterday, Valid: true}
				groupBefore = pgtype.Timestamptz{Time: today, Valid: true}
			case gatewayapi.ChatSessionDateBucketPrevious7Days:
				groupSince = pgtype.Timestamptz{Time: previousWeek, Valid: true}
				groupBefore = pgtype.Timestamptz{Time: yesterday, Valid: true}
			case gatewayapi.ChatSessionDateBucketOlder:
				groupBefore = pgtype.Timestamptz{Time: previousWeek, Valid: true}
			default:
				apiutil.WriteError(w, r, apiutil.NewError(
					http.StatusBadRequest,
					"invalid_request",
					"group_key is invalid",
					errBadRequest,
				))
				return
			}
		}
	}

	cursor, err := decodeChatSessionCursor(params.PageToken)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"page_token is invalid",
			err,
		))
		return
	}

	var agentName pgtype.Text
	if params.AgentName != nil {
		agentName = pgtype.Text{String: *params.AgentName, Valid: true}
	}
	participantIDs := []string{}
	if params.ParticipantUserId != nil {
		participantIDs = *params.ParticipantUserId
	}
	includeWorkflowRuns := auth.workspaceType != agentzv1alpha1.WorkspaceTypeCoding &&
		params.IncludeWorkflowRuns != nil && *params.IncludeWorkflowRuns
	response := gatewayapi.ListChatSessionsResponse{
		Groups:             []gatewayapi.ChatSessionGroup{},
		HasNextPage:        false,
		NextPageToken:      "",
		ParticipantFilters: []gatewayapi.ChatSessionParticipant{},
		Sessions:           []gatewayapi.ChatSession{},
	}

	includeFilterOptions := params.IncludeFilterOptions == nil || *params.IncludeFilterOptions
	if includeFilterOptions && len(agentNames) > 0 {
		filterRows, filterErr := s.queries.GatewayListChatSessionFilterUsers(
			r.Context(),
			gatewaydb.GatewayListChatSessionFilterUsersParams{
				OwnerID:             ownerID,
				AgentNames:          agentNames,
				WorkspaceID:         access.workspaceID,
				IncludeWorkflowRuns: includeWorkflowRuns,
			},
		)
		if filterErr != nil {
			apiutil.WriteInternalError(w, r, fmt.Errorf("list chat session participant filters: %w", filterErr))
			return
		}
		response.ParticipantFilters = make([]gatewayapi.ChatSessionParticipant, 0, len(filterRows))
		for _, row := range filterRows {
			var image *string
			if row.Image.Valid {
				image = &row.Image.String
			}
			response.ParticipantFilters = append(response.ParticipantFilters, gatewayapi.ChatSessionParticipant{
				Id: row.ID, Name: row.Name, Email: openapi_types.Email(row.Email), Image: image,
			})
		}
	}

	if groupBy == gatewayapi.ChatSessionGroupByProject {
		if !ownerID.Valid {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusBadRequest,
					"invalid_request",
					"Project groups require a coding workspace",
					errBadRequest,
				),
			)
			return
		}
		projects, err := s.queries.GatewayListCodingProjects(
			r.Context(),
			gatewaydb.GatewayListCodingProjectsParams{WorkspaceID: access.workspaceID, OwnerID: ownerID.String},
		)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		for _, project := range projects {
			if projectID.Valid && project.ID != projectID.String {
				continue
			}
			group := chatSessionGroup(groupBy, project.ID, activeGroup)
			group.Label = project.Name
			group.Project = &gatewayapi.CodingProject{
				Id: project.ID, Name: project.Name, Repository: project.Repository,
				RepositoryId: project.RepositoryID, DefaultBranch: project.DefaultBranch,
				CreatedAt: project.CreatedAt.Time,
			}
			if project.LastAgentName.Valid {
				group.Project.LastAgentName = &project.LastAgentName.String
			}
			response.Groups = append(response.Groups, group)
		}
		if params.GroupKey == nil {
			apiutil.WriteJSON(w, http.StatusOK, response)
			return
		}
		if len(response.Groups) != 1 {
			apiutil.WriteError(w, r, mapGatewayStoreError("get project", pgx.ErrNoRows))
			return
		}
	}
	hasAgents := len(agentNames) > 0
	grouped := groupBy != gatewayapi.ChatSessionGroupByNone
	groupSelected := params.GroupKey != nil
	switch {
	case hasAgents && grouped && search != "" && !groupSelected:
		groups, searchErr := s.searchChatSessionGroups(
			r.Context(),
			gatewaydb.GatewaySearchGroupedChatSessionsParams{
				OwnerID:             ownerID,
				PageSize:            limit + 1,
				GroupBy:             string(groupBy),
				TodayStart:          today,
				YesterdayStart:      yesterday,
				PreviousWeekStart:   previousWeek,
				WorkspaceID:         access.workspaceID,
				AgentNames:          agentNames,
				IncludeWorkflowRuns: includeWorkflowRuns,
				AgentName:           agentName,
				Search:              search,
				ParticipantUserIds:  participantIDs,
			},
			activeGroup,
		)
		if searchErr != nil {
			apiutil.WriteInternalError(w, r, searchErr)
			return
		}
		response.Groups = groups
	case grouped && !groupSelected && search == "":
		values := agentNames
		switch groupBy {
		case gatewayapi.ChatSessionGroupByStatus:
			values = []string{"busy", "retry", "idle"}
		case gatewayapi.ChatSessionGroupByDate:
			if !hasAgents {
				break
			}
			values, err = s.queries.GatewayListChatSessionDateGroups(
				r.Context(),
				gatewaydb.GatewayListChatSessionDateGroupsParams{
					OwnerID:             ownerID,
					TodayStart:          today,
					YesterdayStart:      yesterday,
					PreviousWeekStart:   previousWeek,
					WorkspaceID:         access.workspaceID,
					AgentNames:          agentNames,
					IncludeWorkflowRuns: includeWorkflowRuns,
					ParticipantUserIds:  participantIDs,
				},
			)
			if err != nil {
				apiutil.WriteInternalError(w, r, fmt.Errorf("list chat session date groups: %w", err))
				return
			}
		}
		for _, value := range values {
			response.Groups = append(response.Groups, chatSessionGroup(groupBy, value, activeGroup))
		}
	case hasAgents:
		sessions, next, listErr := s.listChatSessionPage(
			r.Context(),
			gatewaydb.GatewayListChatSessionsParams{
				ProjectID:           projectID,
				OwnerID:             ownerID,
				AgentNames:          agentNames,
				WorkspaceID:         access.workspaceID,
				IncludeWorkflowRuns: includeWorkflowRuns,
				AgentName:           agentName,
				SearchSet:           search != "",
				Search:              search,
				GroupAgentName:      groupAgent,
				GroupStatus:         groupStatus,
				GroupSince:          groupSince,
				GroupBefore:         groupBefore,
				ParticipantUserIds:  participantIDs,
				CursorSet:           params.PageToken != nil,
				CursorUpdatedAt: pgtype.Timestamptz{
					Time: cursor.UpdatedAt, Valid: params.PageToken != nil,
				},
				CursorAgentName: cursor.AgentName,
				CursorSessionID: cursor.SessionID,
				PageSize:        limit + 1,
			},
		)
		if listErr != nil {
			apiutil.WriteInternalError(w, r, listErr)
			return
		}
		hasNextPage := next != ""
		switch groupBy {
		case gatewayapi.ChatSessionGroupByNone:
			response.Sessions = sessions
			response.HasNextPage = hasNextPage
			response.NextPageToken = next
		case gatewayapi.ChatSessionGroupByProject:
			response.Groups[0].Sessions = sessions
			response.Groups[0].HasNextPage = hasNextPage
			response.Groups[0].NextPageToken = next
		default:
			group := chatSessionGroup(groupBy, groupValue, activeGroup)
			group.Sessions = sessions
			group.HasNextPage = hasNextPage
			group.NextPageToken = next
			response.Groups = append(response.Groups, group)
		}
	case groupSelected && groupBy != gatewayapi.ChatSessionGroupByProject:
		response.Groups = append(response.Groups, chatSessionGroup(groupBy, groupValue, activeGroup))
	}

	apiutil.WriteJSON(w, http.StatusOK, response)
}

func (s *Service) listChatSessionPage(ctx context.Context, q gatewaydb.GatewayListChatSessionsParams) ([]gatewayapi.ChatSession, string, error) {
	rows, err := s.queries.GatewayListChatSessions(ctx, q)
	if err != nil {
		return nil, "", fmt.Errorf("list chat sessions: %w", err)
	}
	limit := int(q.PageSize) - 1
	hasNextPage := len(rows) > limit
	if hasNextPage {
		rows = rows[:limit]
	}
	sessions := make([]gatewayapi.ChatSession, 0, len(rows))
	for _, row := range rows {
		var participants []gatewayapi.ChatSessionParticipant
		decodeErr := json.Unmarshal([]byte(row.ParticipantsJson), &participants)
		if decodeErr != nil {
			return nil, "", fmt.Errorf("decode chat session participants: %w", decodeErr)
		}
		var projectID *string
		if row.ProjectID.Valid {
			projectID = &row.ProjectID.String
		}
		sessions = append(sessions, gatewayapi.ChatSession{
			ProjectId:    projectID,
			AgentName:    row.AgentName,
			SessionId:    row.SessionID,
			Title:        row.Title,
			Kind:         gatewayapi.ChatSessionKind(row.Kind),
			Status:       gatewayapi.ChatSessionStatus(row.Status),
			CreatedAt:    row.SourceCreatedAt.Time,
			UpdatedAt:    row.SourceUpdatedAt.Time,
			Participants: participants,
		})
	}
	if !hasNextPage {
		return sessions, "", nil
	}
	last := rows[len(rows)-1]
	next, err := encodeChatSessionCursor(chatSessionCursor{
		UpdatedAt: last.SourceUpdatedAt.Time,
		AgentName: last.AgentName,
		SessionID: last.SessionID,
	})
	return sessions, next, err
}

func (s *Service) searchChatSessionGroups(ctx context.Context, q gatewaydb.GatewaySearchGroupedChatSessionsParams, activeGroup string) ([]gatewayapi.ChatSessionGroup, error) {
	rows, err := s.queries.GatewaySearchGroupedChatSessions(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("search grouped chat sessions: %w", err)
	}
	groups := []gatewayapi.ChatSessionGroup{}
	currentValue := ""
	var group *gatewayapi.ChatSessionGroup
	for _, row := range rows {
		if row.GroupValue != currentValue {
			value := chatSessionGroup(gatewayapi.ChatSessionGroupBy(q.GroupBy), row.GroupValue, activeGroup)
			groups = append(groups, value)
			group = &groups[len(groups)-1]
			currentValue = row.GroupValue
		}
		if group == nil {
			return nil, errors.New("grouped chat query returned an empty group")
		}
		if len(group.Sessions) == int(q.PageSize-1) {
			group.HasNextPage = true
			continue
		}
		var participants []gatewayapi.ChatSessionParticipant
		decodeErr := json.Unmarshal([]byte(row.ParticipantsJson), &participants)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode chat session participants: %w", decodeErr)
		}
		group.Sessions = append(group.Sessions, gatewayapi.ChatSession{
			AgentName: row.AgentName, SessionId: row.SessionID, Title: row.Title,
			Kind:      gatewayapi.ChatSessionKind(row.Kind),
			Status:    gatewayapi.ChatSessionStatus(row.Status),
			CreatedAt: row.SourceCreatedAt.Time, UpdatedAt: row.SourceUpdatedAt.Time,
			Participants: participants,
		})
	}
	for i := range groups {
		group := &groups[i]
		if !group.HasNextPage {
			continue
		}
		last := group.Sessions[len(group.Sessions)-1]
		group.NextPageToken, err = encodeChatSessionCursor(chatSessionCursor{
			UpdatedAt: last.UpdatedAt,
			AgentName: last.AgentName,
			SessionID: last.SessionId,
		})
		if err != nil {
			return nil, err
		}
	}
	return groups, nil
}

// GetChatSessionPreference handles GET /api/chat-session-preference.
func (s *Service) GetChatSessionPreference(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}

	row, err := s.queries.GatewayGetWorkspaceChatPreference(
		r.Context(),
		gatewaydb.GatewayGetWorkspaceChatPreferenceParams{
			WorkspaceID: access.workspaceID,
			UserID:      claims.UserID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ChatSessionPreference{
			AgentName:           nil,
			GroupBy:             gatewayapi.ChatSessionGroupByNone,
			IncludeWorkflowRuns: false,
			LastAgentName:       nil,
			ParticipantUserIds:  []string{},
		})
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("get chat session preference: %w", err))
		return
	}
	preference := workspaceChatPreference(row)
	auth, _ := requestAuthState(r.Context())
	if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
		preference.IncludeWorkflowRuns = false
	}
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if preference.AgentName != nil && !capabilities[*preference.AgentName].Use {
		preference.AgentName = nil
	}
	if preference.LastAgentName != nil && !capabilities[*preference.LastAgentName].Use {
		preference.LastAgentName = nil
	}
	apiutil.WriteJSON(w, http.StatusOK, preference)
}

// UpdateChatSessionPreference handles PUT /api/chat-session-preference.
func (s *Service) UpdateChatSessionPreference(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}

	var body gatewayapi.ChatSessionPreference
	if !decodeJSONBody(w, r, &body, false) {
		return
	}
	auth, _ := requestAuthState(r.Context())
	if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding && body.IncludeWorkflowRuns {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusForbidden,
			"feature_disabled",
			"workflows are disabled in coding workspaces",
			nil,
		))
		return
	}
	for _, name := range []*gatewayapi.AgentName{body.AgentName, body.LastAgentName} {
		if name == nil {
			continue
		}
		_, apiErr = s.resolveAgentAccess(
			r.Context(),
			*name,
			authorization.OperationUseSharedAgent,
		)
		if apiErr != nil {
			apiutil.WriteError(w, r, apiErr)
			return
		}
	}
	var agentName, lastAgentName pgtype.Text
	if body.AgentName != nil {
		agentName = pgtype.Text{String: *body.AgentName, Valid: true}
	}
	if body.LastAgentName != nil {
		lastAgentName = pgtype.Text{String: *body.LastAgentName, Valid: true}
	}

	projectGroup := body.GroupBy == gatewayapi.ChatSessionGroupByProject
	if projectGroup && auth.workspaceType != agentzv1alpha1.WorkspaceTypeCoding {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"Project groups require a coding workspace",
				errBadRequest,
			),
		)
		return
	}
	row, err := s.queries.GatewayUpsertWorkspaceChatPreference(
		r.Context(),
		gatewaydb.GatewayUpsertWorkspaceChatPreferenceParams{
			WorkspaceID:         access.workspaceID,
			UserID:              claims.UserID,
			AgentName:           agentName,
			ParticipantUserIds:  body.ParticipantUserIds,
			IncludeWorkflowRuns: body.IncludeWorkflowRuns,
			GroupBy:             gatewaydb.ChatSessionGroupBy(body.GroupBy),
			LastAgentName:       lastAgentName,
		},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("update chat session preference: %w", err))
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, workspaceChatPreference(row))
}

// WatchChatSessions handles GET /api/chat-session/watch.
func (s *Service) WatchChatSessions(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		apiutil.WriteInternalError(w, r, errors.New("streaming is unavailable"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	key := access.workspaceID
	auth, _ := requestAuthState(r.Context())
	if auth.workspaceType == agentzv1alpha1.WorkspaceTypeCoding {
		key += "/" + access.claims.UserID
	}
	events, cancel := s.chatSessionEvents.subscribe(key)
	defer cancel()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case revision := <-events:
			raw, err := json.Marshal(gatewayapi.WatchChatSessionsEvent{
				Revision: strconv.FormatUint(revision, 10),
			})
			if err != nil {
				apiutil.RecordRequestError(w, "internal_error", err)
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func encodeChatSessionCursor(cursor chatSessionCursor) (string, error) {
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode chat session cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodeChatSessionCursor(token *gatewayapi.PageTokenQuery) (chatSessionCursor, error) {
	if token == nil {
		return chatSessionCursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(*token)
	if err != nil {
		return chatSessionCursor{}, fmt.Errorf("decode chat session cursor: %w", err)
	}
	var cursor chatSessionCursor
	if err := json.Unmarshal(raw, &cursor); err != nil {
		return chatSessionCursor{}, fmt.Errorf("decode chat session cursor: %w", err)
	}
	if cursor.UpdatedAt.IsZero() || cursor.AgentName == "" || cursor.SessionID == "" {
		return chatSessionCursor{}, errors.New("chat session cursor is incomplete")
	}
	return cursor, nil
}

func decodeChatSessionGroupKey(token gatewayapi.ChatSessionGroupKeyQuery) (chatSessionGroupKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return chatSessionGroupKey{}, fmt.Errorf("decode chat session group key: %w", err)
	}
	groupBy, value, ok := strings.Cut(string(raw), "\x00")
	if !ok || groupBy == "" || value == "" {
		return chatSessionGroupKey{}, errors.New("chat session group key is incomplete")
	}
	return chatSessionGroupKey{GroupBy: gatewayapi.ChatSessionGroupBy(groupBy), Value: value}, nil
}

func chatSessionGroup(groupBy gatewayapi.ChatSessionGroupBy, value, active string) gatewayapi.ChatSessionGroup {
	group := gatewayapi.ChatSessionGroup{
		ContainsActive: value == active,
		GroupBy:        groupBy,
		HasNextPage:    false,
		Key:            base64.RawURLEncoding.EncodeToString([]byte(string(groupBy) + "\x00" + value)),
		NextPageToken:  "",
		Sessions:       []gatewayapi.ChatSession{},
	}
	switch groupBy {
	case gatewayapi.ChatSessionGroupByAgent:
		name := value
		group.AgentName = &name
		group.Label = value
	case gatewayapi.ChatSessionGroupByStatus:
		status := gatewayapi.ChatSessionStatus(value)
		group.Status = &status
		switch status {
		case gatewayapi.ChatSessionStatusBusy:
			group.Label = "Busy"
		case gatewayapi.ChatSessionStatusRetry:
			group.Label = "Retry"
		case gatewayapi.ChatSessionStatusIdle:
			group.Label = "Idle"
		}
	case gatewayapi.ChatSessionGroupByDate:
		bucket := gatewayapi.ChatSessionDateBucket(value)
		group.DateBucket = &bucket
		switch bucket {
		case gatewayapi.ChatSessionDateBucketToday:
			group.Label = "Today"
		case gatewayapi.ChatSessionDateBucketYesterday:
			group.Label = "Yesterday"
		case gatewayapi.ChatSessionDateBucketPrevious7Days:
			group.Label = "Previous 7 days"
		case gatewayapi.ChatSessionDateBucketOlder:
			group.Label = "Older"
		}
	}
	return group
}

func chatSessionDateGroup(updatedAt, today, yesterday, previousWeek time.Time) string {
	switch {
	case !updatedAt.Before(today):
		return string(gatewayapi.ChatSessionDateBucketToday)
	case !updatedAt.Before(yesterday):
		return string(gatewayapi.ChatSessionDateBucketYesterday)
	case !updatedAt.Before(previousWeek):
		return string(gatewayapi.ChatSessionDateBucketPrevious7Days)
	default:
		return string(gatewayapi.ChatSessionDateBucketOlder)
	}
}

func workspaceChatPreference(row gatewaydb.WorkspaceChatPreference) gatewayapi.ChatSessionPreference {
	var agentName *gatewayapi.AgentName
	if row.AgentName.Valid {
		value := row.AgentName.String
		agentName = &value
	}
	var lastAgentName *gatewayapi.AgentName
	if row.LastAgentName.Valid {
		value := row.LastAgentName.String
		lastAgentName = &value
	}
	return gatewayapi.ChatSessionPreference{
		AgentName:           agentName,
		GroupBy:             gatewayapi.ChatSessionGroupBy(row.GroupBy),
		ParticipantUserIds:  row.ParticipantUserIds,
		IncludeWorkflowRuns: row.IncludeWorkflowRuns,
		LastAgentName:       lastAgentName,
	}
}

func (e *chatSessionEvents) subscribe(workspaceID string) (<-chan uint64, func()) {
	ch := make(chan uint64, 1)
	e.mu.Lock()
	if e.watchers == nil {
		e.watchers = make(map[string]map[chan uint64]uint64)
	}
	watchers := e.watchers[workspaceID]
	if watchers == nil {
		watchers = make(map[chan uint64]uint64)
		e.watchers[workspaceID] = watchers
	}
	watchers[ch] = 0
	ch <- 0
	e.mu.Unlock()

	cancel := func() {
		e.mu.Lock()
		watchers := e.watchers[workspaceID]
		if _, ok := watchers[ch]; ok {
			delete(watchers, ch)
			close(ch)
		}
		if len(watchers) == 0 {
			delete(e.watchers, workspaceID)
		}
		e.mu.Unlock()
	}
	return ch, cancel
}

func (e *chatSessionEvents) publish(workspaceID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch, revision := range e.watchers[workspaceID] {
		revision++
		e.watchers[workspaceID][ch] = revision
		select {
		case ch <- revision:
		default:
		}
	}
}

func (s *Service) runChatSessionNotifications(ctx context.Context) {
	for {
		err := s.listenForChatSessionNotifications(ctx)
		if ctx.Err() != nil {
			return
		}
		slog.ErrorContext(ctx, "listen for chat session notifications", slog.Any("err", err))
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (s *Service) listenForChatSessionNotifications(ctx context.Context) error {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire postgres notification connection: %w", err)
	}
	defer conn.Release()

	queries := gatewaydb.New(conn.Conn())
	if err := queries.GatewayListenChatSessions(ctx); err != nil {
		return fmt.Errorf("listen for postgres chat session notifications: %w", err)
	}
	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for postgres chat session notification: %w", err)
		}
		s.chatSessionEvents.publish(notification.Payload)
	}
}
