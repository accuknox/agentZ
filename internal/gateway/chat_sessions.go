package gateway

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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

// ListChatSessions handles GET /api/chat-session.
func (s *Service) ListChatSessions(w http.ResponseWriter, r *http.Request, params gatewayapi.ListChatSessionsParams) {
	access, apiErr := s.resolveAgentAccess(r.Context(), "", authorization.OperationListAgents)
	if apiErr != nil {
		writeError(w, r, apiErr)
		return
	}

	if params.AgentName != nil {
		_, apiErr = s.resolveAgentAccess(
			r.Context(),
			*params.AgentName,
			authorization.OperationUseSharedAgent,
		)
		if apiErr != nil {
			writeError(w, r, apiErr)
			return
		}
	}

	limit := int32(10)
	if params.Limit != nil {
		limit = *params.Limit
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
			UpdatedAt:          time.Unix(0, 0).UTC(),
		})
		return
	}
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("get chat session preference: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, chatSessionPreference(row))
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

	var body gatewayapi.ChatSessionPreferenceInput
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

	row, err := s.queries.GatewayUpsertWorkspaceChatPreference(
		r.Context(),
		gatewaydb.GatewayUpsertWorkspaceChatPreferenceParams{
			WorkspaceID:         access.workspaceID,
			UserID:              claims.UserID,
			AgentName:           nullableAgentName(body.AgentName),
			ParticipantUserIds:  body.ParticipantUserIds,
			IncludeWorkflowRuns: body.IncludeWorkflowRuns,
			LastAgentName:       nullableAgentName(body.LastAgentName),
		},
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("update chat session preference: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, chatSessionPreference(row))
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

	var previous string
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		revision, err := s.queries.GatewayGetChatSessionRevision(r.Context(), access.workspaceID)
		if err != nil {
			recordRequestError(w, "internal_error", fmt.Errorf("watch chat sessions: %w", err))
			return
		}
		if revision != previous {
			raw, err := json.Marshal(gatewayapi.WatchChatSessionsEvent{Revision: revision})
			if err != nil {
				recordRequestError(w, "internal_error", err)
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
				return
			}
			flusher.Flush()
			previous = revision
		}

		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
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

func nullableAgentName(name *gatewayapi.AgentName) pgtype.Text {
	if name == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *name, Valid: true}
}

func chatSessionPreference(row gatewaydb.WorkspaceChatPreference) gatewayapi.ChatSessionPreference {
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
		UpdatedAt:           row.UpdatedAt.Time,
	}
}
