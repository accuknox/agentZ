package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/accuknox/agentz/internal/authorization"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type chatSessionCursor struct {
	UpdatedAt time.Time `json:"updated_at"`
	AgentName string    `json:"agent_name"`
	SessionID string    `json:"session_id"`
}

type chatSessionEvents struct {
	mu       sync.Mutex
	revision uint64
	watchers map[string]map[chan uint64]struct{}
}

// ListChatSessions handles GET /api/chat-session.
func (s *Service) ListChatSessions(w http.ResponseWriter, r *http.Request, params gatewayapi.ListChatSessionsParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	agentNames := usableAgentNames(nil, capabilities)
	if params.AgentName != nil {
		agentNames = []string{}
		capability, ok := capabilities[*params.AgentName]
		if ok && capability.Use {
			agentNames = []string{*params.AgentName}
		}
	}
	if len(agentNames) == 0 {
		writeJSON(w, http.StatusOK, gatewayapi.ListChatSessionsResponse{
			HasNextPage:        false,
			NextPageToken:      "",
			ParticipantFilters: []gatewayapi.ChatSessionParticipant{},
			Sessions:           []gatewayapi.ChatSession{},
		})
		return
	}

	limit := int32(10)
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 50 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 50",
			errBadRequest,
		))
		return
	}
	cursor, err := decodeChatSessionCursor(params.PageToken)
	if err != nil {
		writeError(w, r, newAPIError(
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
	includeWorkflowRuns := params.IncludeWorkflowRuns != nil && *params.IncludeWorkflowRuns
	rows, err := s.queries.GatewayListChatSessions(
		r.Context(),
		gatewaydb.GatewayListChatSessionsParams{
			AgentNames:          agentNames,
			WorkspaceID:         access.workspaceID,
			IncludeWorkflowRuns: includeWorkflowRuns,
			AgentName:           agentName,
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
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list chat sessions: %w", err))
		return
	}

	hasNextPage := len(rows) > int(limit)
	if hasNextPage {
		rows = rows[:limit]
	}
	sessions := make([]gatewayapi.ChatSession, 0, len(rows))
	for _, row := range rows {
		var participants []gatewayapi.ChatSessionParticipant
		if err := json.Unmarshal([]byte(row.ParticipantsJson), &participants); err != nil {
			writeInternalError(w, r, fmt.Errorf("decode chat session participants: %w", err))
			return
		}
		sessions = append(sessions, gatewayapi.ChatSession{
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

	filterRows, err := s.queries.GatewayListChatSessionFilterUsers(
		r.Context(),
		gatewaydb.GatewayListChatSessionFilterUsersParams{
			AgentNames:          agentNames,
			WorkspaceID:         access.workspaceID,
			IncludeWorkflowRuns: includeWorkflowRuns,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list chat session participant filters: %w", err))
		return
	}
	filters := make([]gatewayapi.ChatSessionParticipant, 0, len(filterRows))
	for _, row := range filterRows {
		var image *string
		if row.Image.Valid {
			image = &row.Image.String
		}
		filters = append(filters, gatewayapi.ChatSessionParticipant{
			Id: row.ID, Name: row.Name, Email: openapi_types.Email(row.Email), Image: image,
		})
	}

	nextPageToken := ""
	if hasNextPage {
		last := rows[len(rows)-1]
		nextPageToken, err = encodeChatSessionCursor(chatSessionCursor{
			UpdatedAt: last.SourceUpdatedAt.Time,
			AgentName: last.AgentName,
			SessionID: last.SessionID,
		})
		if err != nil {
			writeInternalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, gatewayapi.ListChatSessionsResponse{
		Sessions:           sessions,
		ParticipantFilters: filters,
		HasNextPage:        hasNextPage,
		NextPageToken:      nextPageToken,
	})
}

// GetChatSessionPreference handles GET /api/chat-session-preference.
func (s *Service) GetChatSessionPreference(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
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
		writeJSON(w, http.StatusOK, gatewayapi.ChatSessionPreference{
			ParticipantUserIds: []string{},
		})
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get chat session preference: %w", err))
		return
	}
	preference := workspaceChatPreference(row)
	capabilities, err := s.agentCapabilityProjections(r.Context(), access, "")
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if preference.AgentName != nil && !capabilities[*preference.AgentName].Use {
		preference.AgentName = nil
	}
	if preference.LastAgentName != nil && !capabilities[*preference.LastAgentName].Use {
		preference.LastAgentName = nil
	}
	writeJSON(w, http.StatusOK, preference)
}

// UpdateChatSessionPreference handles PUT /api/chat-session-preference.
func (s *Service) UpdateChatSessionPreference(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	claims, apiErr := externalWorkspaceClaims(r.Context())
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	var body gatewayapi.ChatSessionPreference
	if !decodeJSONBody(w, r, &body, false) {
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
			writeError(w, r, apiErr)
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

	row, err := s.queries.GatewayUpsertWorkspaceChatPreference(
		r.Context(),
		gatewaydb.GatewayUpsertWorkspaceChatPreferenceParams{
			WorkspaceID:         access.workspaceID,
			UserID:              claims.UserID,
			AgentName:           agentName,
			ParticipantUserIds:  body.ParticipantUserIds,
			IncludeWorkflowRuns: body.IncludeWorkflowRuns,
			LastAgentName:       lastAgentName,
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("update chat session preference: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, workspaceChatPreference(row))
}

// WatchChatSessions handles GET /api/chat-session/watch.
func (s *Service) WatchChatSessions(w http.ResponseWriter, r *http.Request) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeInternalError(w, r, errors.New("streaming is unavailable"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	events, cancel := s.chatSessionEvents.subscribe(access.workspaceID)
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
				recordRequestError(w, "internal_error", err)
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
		ParticipantUserIds:  row.ParticipantUserIds,
		IncludeWorkflowRuns: row.IncludeWorkflowRuns,
		LastAgentName:       lastAgentName,
	}
}

func (e *chatSessionEvents) subscribe(workspaceID string) (<-chan uint64, func()) {
	ch := make(chan uint64, 1)
	e.mu.Lock()
	if e.watchers == nil {
		e.watchers = make(map[string]map[chan uint64]struct{})
	}
	watchers := e.watchers[workspaceID]
	if watchers == nil {
		watchers = make(map[chan uint64]struct{})
		e.watchers[workspaceID] = watchers
	}
	watchers[ch] = struct{}{}
	ch <- e.revision
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
	e.revision++
	for ch := range e.watchers[workspaceID] {
		select {
		case ch <- e.revision:
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
