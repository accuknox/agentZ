package gateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type workflowSessionBinding struct {
	Name string `json:"agentz.dev/workflow-run"`
	UID  string `json:"agentz.dev/workflow-uid"`
}

type privateNativeCursor struct {
	Workspace string `json:"workspace"`
	Agent     string `json:"agent"`
	Owner     string `json:"owner"`
	Session   string `json:"session"`
}

const longRunningSessionPrefix = "ses_lr_"

// privateChatRoot follows native ancestry before classifying an unindexed child.
// A reserved native ID without its SQL receipt is never imported as shared history.
func (s *Service) privateChatRoot(ctx context.Context, access resourceAccess, agent, session string) (gatewaydb.ChatSession, bool, error) {
	var root gatewaydb.ChatSession
	seen := make(map[string]bool)
	for session != "" {
		if seen[session] || len(seen) >= 128 {
			return root, false, pgx.ErrNoRows
		}
		seen[session] = true
		row, err := s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return root, false, err
		}
		if err == nil && row.PrivateRootSessionID.Valid {
			root, err = s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
				WorkspaceID: access.workspaceID,
				AgentName:   agent,
				SessionID:   row.PrivateRootSessionID.String,
			})
			return root, true, err
		}
		if strings.HasPrefix(session, longRunningSessionPrefix) {
			return root, true, pgx.ErrNoRows
		}
		if err == nil && !row.ParentSessionID.Valid {
			return root, false, nil
		}
		if err == nil && row.ParentSessionID.Valid {
			session = row.ParentSessionID.String
			continue
		}
		client, err := s.agentClient(ctx, access.namespace, agent, s.outboundHTTP)
		if err != nil {
			return root, false, err
		}
		native, err := client.SessionGetWithResponse(ctx, agent, session, nil)
		if err != nil {
			return root, false, err
		}
		if native.JSON200 == nil {
			return root, false, pgx.ErrNoRows
		}
		if native.JSON200.ParentID == nil {
			return root, false, nil
		}
		session = *native.JSON200.ParentID
	}
	return root, false, nil
}

func (s *Service) authorizeChat(ctx context.Context, access resourceAccess, agent, session string) (gatewaydb.ChatSession, bool, error) {
	root, private, err := s.privateChatRoot(ctx, access, agent, session)
	if err != nil || !private {
		return root, private, err
	}
	auth, _ := requestAuthState(ctx)
	if auth.actorType == requestActorSystem {
		runs := &agentzv1alpha1.WorkflowRunList{}
		if err := s.k8sClient.List(ctx, runs, ctrlclient.InNamespace(access.namespace)); err != nil {
			return root, true, err
		}
		for _, run := range runs.Items {
			bound := run.Spec.Delivery != nil && run.Spec.Delivery.SessionID == root.SessionID
			if run.Status.SessionID != session || run.Spec.AgentName != agent || !bound {
				continue
			}
			err := s.authorizeWorkflowDelivery(ctx, access, agent, run.Spec.Delivery)
			return root, true, err
		}
		return root, true, pgx.ErrNoRows
	}
	if root.Deleting || root.OwnerID.String != access.userID {
		return root, true, pgx.ErrNoRows
	}

	if auth.apiKeyID != "" {
		active, err := s.queries.GatewayAPIKeyCanUseAgent(ctx, gatewaydb.GatewayAPIKeyCanUseAgentParams{
			ApiKeyID:    auth.apiKeyID,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
			AgentName:   agent,
		})
		if err != nil {
			return root, true, err
		}
		if !active {
			return root, true, pgx.ErrNoRows
		}
		auth.apiKeyID = ""
		auth.actorType = requestActorUser
		auth.claims = &gatewayClaims{
			UserID:         auth.userID,
			OrganizationID: auth.organizationID,
			WorkspaceID:    auth.workspaceID,
		}
		ctx = context.WithValue(ctx, authContextKey{}, auth)
	}
	_, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		if apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound {
			return root, true, pgx.ErrNoRows
		}
		return root, true, apiErr
	}

	return root, true, nil
}

// CreateLongRunningChat reserves ownership before the native session can publish events.
func (s *Service) CreateLongRunningChat(w http.ResponseWriter, r *http.Request) {
	var input gatewayapi.LongRunningChatRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), input.AgentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	auth, _ := requestAuthState(r.Context())
	if auth.actorType == requestActorSystem || access.userID == "" {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("a conversation owner is required")))
		return
	}
	workspace, err := s.queries.GatewayGetWorkspace(r.Context(), gatewaydb.GatewayGetWorkspaceParams{
		ID:             access.workspaceID,
		OrganizationID: access.organizationID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if workspace.Type != gatewaydb.WorkspaceTypeGeneral {
		apiutil.WriteError(w, r, resourceForbidden(errors.New("long-running conversations require a General workspace")))
		return
	}
	ctx, releaseLocks, err := gatewayLocks(r.Context(), s.controlDB)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if releaseLocks != nil {
		defer releaseLocks()
	}
	r = r.WithContext(ctx)
	_, release, err := lockGatewayResource(r.Context(), s.controlDB, "chat-creation/"+input.Id.String(), false)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer release()
	raw, err := json.Marshal(input)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	receipt, err := s.queries.GatewayReserveLongRunningChat(r.Context(), gatewaydb.GatewayReserveLongRunningChatParams{
		ID:          input.Id,
		WorkspaceID: access.workspaceID,
		AgentName:   input.AgentName,
		OwnerID:     access.userID,
		Request:     raw,
		SessionID:   longRunningSessionPrefix + strings.ReplaceAll(input.Id.String(), "-", ""),
	})
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusConflict, "creation_conflict",
			"This creation request conflicts with an existing conversation", err,
		))
		return
	}
	unlock, err := s.lockChatInputs(r.Context(), access.workspaceID, input.AgentName, receipt.SessionID, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer unlock()
	root, err := s.queries.GatewayGetChatSession(r.Context(), gatewaydb.GatewayGetChatSessionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   input.AgentName,
		SessionID:   receipt.SessionID,
	})
	if err != nil || root.Deleting {
		apiutil.WriteError(w, r, mapGatewayStoreError("create conversation", pgx.ErrNoRows))
		return
	}
	client, err := s.agentClient(r.Context(), access.namespace, input.AgentName, s.outboundHTTP)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	// V2 create is ID-addressed and interoperates with legacy history and prompts.
	if receipt.State != "created" {
		result, createErr := client.V2SessionCreateWithResponse(r.Context(), input.AgentName, gatewayapi.V2SessionCreateJSONRequestBody{
			Id:    &receipt.SessionID,
			Agent: input.Agent,
			Model: input.Model,
		})
		if createErr == nil && result.JSON200 == nil {
			createErr = fmt.Errorf("native creation returned %s", result.Status())
		}
		state, diagnostic := "created", ""
		if createErr != nil {
			state, diagnostic = "uncertain", "Native creation is uncertain. Retry this same draft to reconcile it."
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 15*time.Second)
		defer cancel()
		_, err = s.queries.GatewayFinishChatCreation(ctx, gatewaydb.GatewayFinishChatCreationParams{
			ID:          input.Id,
			WorkspaceID: access.workspaceID,
			OwnerID:     access.userID,
			State:       state,
			Error:       diagnostic,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if createErr != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "creation_uncertain", diagnostic, createErr))
			return
		}
	}
	native, err := client.SessionGetWithResponse(r.Context(), input.AgentName, receipt.SessionID, nil)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if native.JSON200 == nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get conversation", pgx.ErrNoRows))
		return
	}
	err = s.storeOpenCodeSession(r.Context(), access.workspaceID, input.AgentName, gatewaydb.ChatSessionKindChat, *native.JSON200)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, native.JSON200)
}

// GetChatProactivity returns immutable mode and owner-visible timing settings.
func (s *Service) GetChatProactivity(w http.ResponseWriter, r *http.Request, agent, session string) {
	access, _, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get conversation", err))
		return
	}
	row, err := s.queries.GatewayGetChatProactivity(r.Context(), gatewaydb.GatewayGetChatProactivityParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ChatProactivity{})
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result := gatewayapi.ChatProactivity{
		LongRunning:     row.LongRunning,
		Paused:          row.ProactivePaused,
		IntervalSeconds: row.AutomaticCheckIntervalSeconds,
	}
	if row.NextCheckAt.Valid {
		result.NextCheckAt = &row.NextCheckAt.Time
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// UpdateChatProactivity pauses or resumes checks without changing agent cadence or ownership.
func (s *Service) UpdateChatProactivity(w http.ResponseWriter, r *http.Request, agent, session string) {
	var input gatewayapi.ChatProactivityUpdate
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, _, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get conversation", err))
		return
	}
	release, err := s.lockChatInputs(r.Context(), access.workspaceID, agent, session, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer release()
	row, err := s.queries.GatewayUpdateProactivity(r.Context(), gatewaydb.GatewayUpdateProactivityParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
		OwnerID:     pgtype.Text{String: access.userID, Valid: true},
		Paused:      input.Paused,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("update conversation", err))
		return
	}
	s.notifyChatInput(r.Context(), gatewaydb.ChatInput{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	apiutil.WriteJSON(w, http.StatusOK, gatewayapi.ChatProactivity{
		LongRunning:     row.LongRunning,
		Paused:          row.ProactivePaused,
		IntervalSeconds: row.AutomaticCheckIntervalSeconds,
		NextCheckAt:     &row.NextCheckAt.Time,
	})
}

// ListChatBackground classifies internal turns by persisted native message identity.
func (s *Service) ListChatBackground(w http.ResponseWriter, r *http.Request, agent, session string) {
	access, _, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get conversation", err))
		return
	}
	rows, err := s.queries.GatewayListChatBackground(r.Context(), gatewaydb.GatewayListChatBackgroundParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result := make([]gatewayapi.ChatBackground, 0, len(rows))
	for _, row := range rows {

		item := gatewayapi.ChatBackground{
			MessageId: row.MessageID,
			PartId:    row.PartID.String,
			Origin:    gatewayapi.ChatBackgroundOrigin(row.Origin),
			Completed: row.CompletedAt.Valid,
			Error:     row.Error,
		}
		if row.Outcome.Valid {
			outcome := gatewayapi.ChatBackgroundOutcome(row.Outcome.ChatBackgroundOutcome)
			item.Outcome = &outcome
		}
		result = append(result, item)
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func (s *Service) enforcePrivateChat(r *http.Request, access resourceAccess, route *opencodeRouteMatch, agent string) (release func(), err error) {
	session := route.Params["sessionID"]
	if session != "" && route.ID != "permission.respond" {
		_, private, err := s.authorizeChat(r.Context(), access, agent, session)
		if err != nil {
			return release, err
		}
		if private && (route.ID == "session.fork" || route.ID == "session.share") {
			return release, pgx.ErrNoRows
		}
		return release, nil
	}
	// Legacy approval routes carry request identity rather than session identity.
	approval := route.ID == "permission.reply" || route.ID == "permission.respond"
	question := route.ID == "question.reply" || route.ID == "question.reject"
	if approval || question {
		client, err := s.agentClient(r.Context(), access.namespace, agent, s.outboundHTTP)
		if err != nil {
			return release, err
		}
		if route.ID == "permission.reply" || route.ID == "permission.respond" {
			requests, err := client.PermissionListWithResponse(r.Context(), agent, nil)
			if err != nil {
				return release, err
			}
			if requests.JSON200 == nil {
				return release, pgx.ErrNoRows
			}
			requestID := route.Params["requestID"]
			if route.ID == "permission.respond" {
				requestID = route.Params["permissionID"]
			}
			for _, request := range *requests.JSON200 {
				if request.Id == requestID {
					if session != "" && session != request.SessionID {
						return release, pgx.ErrNoRows
					}
					_, _, err = s.authorizeChat(r.Context(), access, agent, request.SessionID)
					return release, err
				}
			}
		} else {
			requests, err := client.QuestionListWithResponse(r.Context(), agent, nil)
			if err != nil {
				return release, err
			}
			if requests.JSON200 == nil {
				return release, pgx.ErrNoRows
			}
			for _, request := range *requests.JSON200 {
				if request.Id == route.Params["requestID"] {
					_, _, err = s.authorizeChat(r.Context(), access, agent, request.SessionID)
					return release, err
				}
			}
		}
		return release, pgx.ErrNoRows
	}
	if route.ID == "session.create" {
		var body gatewayapi.SessionCreateJSONBody
		if err := apiutil.DecodeJSONBody(r, &body, true); err != nil {
			return release, err
		}
		if body.ParentID != nil {
			root, private, err := s.privateChatRoot(r.Context(), access, agent, *body.ParentID)
			if err != nil {
				return release, err
			}
			if private {
				auth, _ := requestAuthState(r.Context())
				if auth.actorType != requestActorSystem {
					return release, pgx.ErrNoRows
				}
				var binding workflowSessionBinding
				raw, err := json.Marshal(body.Metadata)
				if err != nil {
					return release, err
				}
				if err := json.Unmarshal(raw, &binding); err != nil {
					return release, err
				}
				run := &agentzv1alpha1.WorkflowRun{}
				key := ctrlclient.ObjectKey{Namespace: access.namespace, Name: binding.Name}
				err = s.k8sClient.Get(r.Context(), key, run)
				if err != nil {
					return release, err
				}
				bound := run.Spec.Delivery != nil && run.Spec.Delivery.SessionID == root.SessionID
				current := !run.Status.Phase.Terminal() && run.DeletionTimestamp.IsZero()
				if string(run.UID) != binding.UID || run.Spec.AgentName != agent || !bound || !current {
					return release, pgx.ErrNoRows
				}
				release, err = s.lockChatInputs(r.Context(), access.workspaceID, agent, root.SessionID, "")
				if err != nil {
					return release, err
				}
				if err := s.authorizeWorkflowDelivery(r.Context(), access, agent, run.Spec.Delivery); err != nil {
					return release, err
				}
			}
		}

		raw, err := json.Marshal(body)
		if err != nil {
			return release, err
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		r.ContentLength = int64(len(raw))
	}
	if route.ID == "v2.session.create" {
		var body gatewayapi.V2SessionCreateJSONBody
		if err := apiutil.DecodeJSONBody(r, &body, true); err != nil {
			return release, err
		}
		if body.Id != nil && strings.HasPrefix(*body.Id, longRunningSessionPrefix) {
			return release, pgx.ErrNoRows
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return release, err
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		r.ContentLength = int64(len(raw))
	}
	if route.ID == "session.list" || route.ID == "v2.session.list" {
		private, err := s.queries.GatewayAgentHasPrivateChats(r.Context(), gatewaydb.GatewayAgentHasPrivateChatsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
		})
		if err != nil {
			return release, err
		}
		if private {
			query := r.URL.Query()
			limit := 100
			if value := query.Get("limit"); value != "" {
				limit, err = strconv.Atoi(value)
				if err != nil || limit < 1 || limit > 1000 {
					return release, apiutil.NewError(http.StatusBadRequest, "invalid_limit", "Limit must be between 1 and 1000", nil)
				}
			}
			route.CatalogLimit = &limit
			if value := query.Get("cursor"); value != "" {
				raw, err := base64.RawURLEncoding.DecodeString(value)
				if err != nil {
					return release, apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid conversation cursor", err)
				}
				var cursor privateNativeCursor
				err = json.Unmarshal(raw, &cursor)
				scoped := cursor.Workspace == access.workspaceID && cursor.Agent == agent && cursor.Owner == access.userID
				if err != nil || !scoped || cursor.Session == "" {
					return release, apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Invalid conversation cursor", err)
				}
				route.CatalogCursor = cursor.Session
			}
			query.Del("cursor")
			query.Set("limit", "1000")
			if route.ID == "session.list" {
				query.Set("limit", "-1")
			}
			r.URL.RawQuery = query.Encode()
		}
	}

	unsafe := strings.HasPrefix(route.ID, "sync.") || strings.HasPrefix(route.ID, "tui.") ||
		route.ID == "v2.event.subscribe" || route.ID == "experimental.controlPlane.moveSession"
	if unsafe {
		private, err := s.queries.GatewayAgentHasPrivateChats(r.Context(), gatewaydb.GatewayAgentHasPrivateChatsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
		})
		if err != nil {
			return release, err
		}
		if !private {
			client, err := s.agentClient(r.Context(), access.namespace, agent, s.outboundHTTP)
			if err != nil {
				return release, err
			}
			limit := float32(-1)
			sessions, err := client.SessionListWithResponse(r.Context(), agent, &gatewayapi.SessionListParams{Limit: &limit})
			if err != nil {
				return release, err
			}
			if sessions.JSON200 == nil {
				return release, pgx.ErrNoRows
			}
			for _, session := range *sessions.JSON200 {
				if strings.HasPrefix(session.Id, longRunningSessionPrefix) {
					private = true
					break
				}
			}
		}
		if private {
			return release, pgx.ErrNoRows
		}
	}
	return release, nil
}

func (s *Service) filterPrivateChatResponse(ctx context.Context, resp *http.Response, route *opencodeRouteMatch, workspace, agent string) error {
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	auth, _ := requestAuthState(ctx)
	namespace, err := tenantNamespace(ctx)
	if err != nil {
		return err
	}
	access := resourceAccess{
		workspaceID:    workspace,
		organizationID: auth.organizationID,
		namespace:      namespace,
		userID:         auth.userID,
	}
	visible := func(session string) (bool, error) {
		_, _, err := s.authorizeChat(ctx, access, agent, session)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return err == nil, err
	}
	switch route.ID {
	case "session.list", "session.children":
		sessions, err := decodeOpenCodeResponse[[]gatewayapi.OpencodeSession](resp)
		if err != nil {
			return err
		}
		filtered := make([]gatewayapi.OpencodeSession, 0, len(sessions))
		for _, session := range sessions {
			ok, err := visible(session.Id)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, session)
			}
		}
		if route.CatalogLimit != nil && len(filtered) > *route.CatalogLimit {
			filtered = filtered[:*route.CatalogLimit]
		}
		return replaceOpenCodeResponse(resp, filtered)
	case "v2.session.list":
		result, err := decodeOpenCodeResponse[gatewayapi.OpencodeSessionsResponse](resp)
		if err != nil {
			return err
		}
		if route.CatalogLimit != nil {
			client, err := s.agentClient(ctx, namespace, agent, s.outboundHTTP)
			if err != nil {
				return err
			}
			query := resp.Request.URL.Query()
			limit := float32(1000)
			params := &gatewayapi.V2SessionListParams{Limit: &limit}
			if query.Has("search") {
				value := query.Get("search")
				params.Search = &value
			}
			if query.Has("directory") {
				value := query.Get("directory")
				params.Directory = &value
			}
			if query.Has("project") {
				value := query.Get("project")
				params.Project = &value
			}
			if query.Has("workspace") {
				value := query.Get("workspace")
				params.Workspace = &value
			}
			if query.Has("subpath") {
				value := query.Get("subpath")
				params.Subpath = &value
			}
			if query.Has("order") {
				value := gatewayapi.V2SessionListParamsOrder(query.Get("order"))
				params.Order = &value
			}
			seen := make(map[string]bool)
			size := 0
			for result.Cursor.Next != nil {
				cursor := *result.Cursor.Next
				if cursor == "" || seen[cursor] {
					return errors.New("native conversation cursor did not advance")
				}
				seen[cursor] = true
				params.Cursor = &cursor
				next, err := client.V2SessionListWithResponse(ctx, agent, params)
				if err != nil {
					return err
				}
				if next.JSON200 == nil {
					return errors.New("cannot read native conversation page")
				}
				size += len(next.Body)
				if size > opencodeProxyBodyLimitBytes {
					return errors.New("native conversation catalog exceeds maximum size")
				}
				result.Data = append(result.Data, next.JSON200.Data...)
				result.Cursor = next.JSON200.Cursor
			}
		}
		filtered := make([]gatewayapi.OpencodeSessionV2Info, 0, len(result.Data))
		for _, session := range result.Data {
			ok, err := visible(session.Id)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, session)
			}
		}
		if route.CatalogLimit != nil {
			result.Cursor.Next = nil
			result.Cursor.Previous = nil
			if route.CatalogCursor != "" {
				found := false
				for i, session := range filtered {
					if session.Id == route.CatalogCursor {
						filtered = filtered[i+1:]
						found = true
						break
					}
				}
				if !found {
					return apiutil.NewError(http.StatusBadRequest, "invalid_cursor", "Conversation cursor no longer exists", nil)
				}
			}
			if len(filtered) > *route.CatalogLimit {
				filtered = filtered[:*route.CatalogLimit]
				raw, err := json.Marshal(privateNativeCursor{
					Workspace: workspace,
					Agent:     agent,
					Owner:     auth.userID,
					Session:   filtered[len(filtered)-1].Id,
				})
				if err != nil {
					return err
				}
				cursor := base64.RawURLEncoding.EncodeToString(raw)
				result.Cursor.Next = &cursor
			}
		}
		result.Data = filtered
		return replaceOpenCodeResponse(resp, result)
	case "v2.session.active":
		result, err := gatewayapi.ParseV2SessionActiveResp(resp)
		if err != nil {
			return err
		}
		if result.JSON200 == nil {
			return errors.New("invalid active sessions response")
		}
		for session := range result.JSON200.Data {
			ok, err := visible(session)
			if err != nil {
				return err
			}
			if !ok {
				delete(result.JSON200.Data, session)
			}
		}
		return replaceOpenCodeResponse(resp, result.JSON200)
	case "v2.permission.request.list":
		result, err := decodeOpenCodeResponse[gatewayapi.OpencodePermissionRequestsResponse](resp)
		if err != nil {
			return err
		}
		filtered := make([]gatewayapi.OpencodePermissionV2Request, 0, len(result.Data))
		for _, request := range result.Data {
			ok, err := visible(request.SessionID)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, request)
			}
		}
		result.Data = filtered
		return replaceOpenCodeResponse(resp, result)
	case "v2.question.request.list":
		result, err := decodeOpenCodeResponse[gatewayapi.OpencodeQuestionRequestsResponse](resp)
		if err != nil {
			return err
		}
		filtered := make([]gatewayapi.OpencodeQuestionV2Request, 0, len(result.Data))
		for _, request := range result.Data {
			ok, err := visible(request.SessionID)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, request)
			}
		}
		result.Data = filtered
		return replaceOpenCodeResponse(resp, result)
	case "permission.list":
		requests, err := decodeOpenCodeResponse[[]gatewayapi.OpencodePermissionRequest](resp)
		if err != nil {
			return err
		}
		filtered := make([]gatewayapi.OpencodePermissionRequest, 0, len(requests))
		for _, request := range requests {
			ok, err := visible(request.SessionID)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, request)
			}
		}
		return replaceOpenCodeResponse(resp, filtered)
	case "question.list":
		requests, err := decodeOpenCodeResponse[[]gatewayapi.OpencodeQuestionRequest](resp)
		if err != nil {
			return err
		}
		filtered := make([]gatewayapi.OpencodeQuestionRequest, 0, len(requests))
		for _, request := range requests {
			ok, err := visible(request.SessionID)
			if err != nil {
				return err
			}
			if ok {
				filtered = append(filtered, request)
			}
		}
		return replaceOpenCodeResponse(resp, filtered)
	}
	return nil
}

const proactiveInstruction = `This is an automatic check for this long-running conversation.
Review the conversation and work already requested by its owner.
Continue only work authorized by the owner's requests or standing instructions.
Offer genuinely new work for the owner to accept; do not start it yet.
Follow the existing tool permissions and approval requirements.
Do not repeat an offer already answered or dismissed here.
If there is no useful update or action requiring the owner's attention, finish with exactly NO_UPDATE and no other user-facing text.
If you performed meaningful work, report its outcome instead of NO_UPDATE.`

func (s *Service) runBackgroundChecks(ctx context.Context, cursor int64) (int64, error) {
	content, err := json.Marshal(gatewayapi.ChatInputContent{
		Text:        "Run the automatic check now. First carry out unfinished work the owner authorized for this check, including standing instructions. Report completed work or blockers. If no authorized work remains and there is no new update or useful offer, return exactly NO_UPDATE. Do not send an acknowledgement or a no-work summary.",
		Attachments: []gatewayapi.ChatAttachment{},
	})
	if err != nil {
		return cursor, err
	}
	if _, err = s.queries.GatewayEnqueueProactiveChecks(ctx, content); err != nil {
		return cursor, err
	}
	rows, err := s.queries.GatewayOutstandingBackgroundInputs(ctx, cursor)
	if err != nil {
		return cursor, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return cursor, nil
		}
		cursor = row.Sequence.Int64
		checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		ownerCtx := context.WithValue(checkCtx, authContextKey{}, requestAuth{
			claims: &gatewayClaims{
				UserID:         row.AuthorID,
				OrganizationID: row.OrganizationID,
				WorkspaceID:    row.WorkspaceID,
			},
			userID:         row.AuthorID,
			userName:       row.AuthorName,
			actorID:        row.AuthorID,
			actorName:      row.AuthorName,
			actorType:      requestActorUser,
			workspaceID:    row.WorkspaceID,
			organizationID: row.OrganizationID,
		})
		access, directory, _, err := s.chatInputAccess(ownerCtx, row.AgentName, row.SessionID)
		if err != nil {
			cancel()
			continue
		}
		release, err := s.lockChatInputs(ownerCtx, row.WorkspaceID, row.AgentName, row.SessionID, "")
		if err != nil {
			cancel()
			continue
		}
		err = s.completeBackgroundInput(ownerCtx, access, directory, row)
		release()
		cancel()
		if err != nil {
			slog.ErrorContext(ctx, "reconcile internal turn", "input", row.ID, "error", err)
		}
	}
	return cursor, nil
}

func (s *Service) completeBackgroundInput(ctx context.Context, access resourceAccess, directory string, row gatewaydb.ChatInput) error {
	current, err := s.queries.GatewayGetChatInput(ctx, gatewaydb.GatewayGetChatInputParams{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		AgentName:   row.AgentName,
		SessionID:   row.SessionID,
	})
	if err != nil || current.CompletedAt.Valid {
		return err
	}
	row = current
	client, err := s.agentClient(ctx, access.namespace, row.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	if row.State != "delivered" {
		row, err = s.reconcileChatInput(ctx, client, directory, row)
		if err != nil {
			return err
		}
	}
	if row.State == "failed" && row.MessageID == "" {
		_, err = s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{ID: row.ID, Error: row.Error})
		return err
	}
	if row.State != "delivered" {
		return nil
	}
	outcome := gatewaydb.ChatBackgroundOutcomeUpdate
	if row.Origin == gatewaydb.ChatInputOriginProactive {
		history, err := client.SessionMessagesWithResponse(
			ctx, row.AgentName, row.SessionID, &gatewayapi.SessionMessagesParams{Directory: &directory},
		)
		if err != nil {
			return err
		}
		if history.JSON200 == nil {
			return errors.New("cannot read proactive completion")
		}
		superseded := false
		terminal := false
		failed := false
		var text strings.Builder
		for _, message := range *history.JSON200 {
			kind, err := message.Info.Discriminator()
			if err != nil {
				return err
			}
			if kind == "user" {
				user, err := message.Info.AsOpencodeUserMessage()
				if err != nil {
					return err
				}
				if user.Id != row.MessageID && user.Time.Created > row.UpdatedAt.UnixMilli() {
					synthetic := false
					for _, part := range message.Parts {
						kind, err := part.Discriminator()
						if err != nil {
							return err
						}
						if kind != "text" {
							continue
						}
						text, err := part.AsOpencodeTextPart()
						if err != nil {
							return err
						}
						if text.Synthetic != nil && *text.Synthetic {
							synthetic = true
						}
					}
					if !synthetic {
						superseded = true
					}
				}
				continue
			}
			if kind != "assistant" {
				continue
			}
			assistant, err := message.Info.AsOpencodeAssistantMessage()
			if err != nil {
				return err
			}
			if assistant.ParentID != row.MessageID || assistant.Time.Completed == nil {
				continue
			}
			failed = failed || assistant.Error != nil
			if assistant.Finish == nil || *assistant.Finish == "tool-calls" || *assistant.Finish == "unknown" {
				continue
			}
			terminal = true
			for _, part := range message.Parts {
				kind, err := part.Discriminator()
				if err != nil {
					return err
				}
				if kind != "text" {
					continue
				}
				value, err := part.AsOpencodeTextPart()
				if err != nil {
					return err
				}
				text.WriteString(value.Text)
			}
		}
		if failed {
			_, err = s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
				ID:    row.ID,
				Error: "The automatic check failed. The next check will run at the configured interval.",
			})
			return err
		}
		if !terminal {
			if time.Since(row.UpdatedAt) < time.Minute {
				return nil
			}
			status, err := client.SessionStatusWithResponse(ctx, row.AgentName, &gatewayapi.SessionStatusParams{Directory: &directory})
			if err != nil {
				return err
			}
			if status.JSON200 == nil {
				return errors.New("cannot confirm background status")
			}
			if state, ok := (*status.JSON200)[row.SessionID]; ok {
				kind, err := state.Discriminator()
				if err != nil {
					return err
				}
				if kind != "idle" {
					return nil
				}
			}
			if superseded {
				_, err = s.queries.GatewayCompleteBackgroundInput(ctx, gatewaydb.GatewayCompleteBackgroundInputParams{
					ID: row.ID,
					Outcome: gatewaydb.NullChatBackgroundOutcome{
						ChatBackgroundOutcome: gatewaydb.ChatBackgroundOutcomeCanceled,
						Valid:                 true,
					},
				})
				return err
			}
			_, err = s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
				ID:    row.ID,
				Error: "The automatic check ended without a confirmed result. It will not be replayed.",
			})
			return err
		}
		if strings.TrimSpace(text.String()) == "NO_UPDATE" {
			outcome = gatewaydb.ChatBackgroundOutcomeQuiet
		}
	}
	_, err = s.queries.GatewayCompleteBackgroundInput(ctx, gatewaydb.GatewayCompleteBackgroundInputParams{
		ID:      row.ID,
		Outcome: gatewaydb.NullChatBackgroundOutcome{ChatBackgroundOutcome: outcome, Valid: true},
	})
	if err == nil {
		s.notifyChatInput(ctx, row)
	}
	return err
}

// authorizeWorkflowDelivery returns pgx.ErrNoRows for confirmed denial; other failures remain retryable.
func (s *Service) authorizeWorkflowDelivery(ctx context.Context, access resourceAccess, agent string, delivery *agentzv1alpha1.WorkflowDelivery) error {
	root, err := s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   delivery.SessionID,
	})
	if err != nil {
		return err
	}
	current := root.LongRunning && !root.Deleting && root.Generation == delivery.Generation
	if !current || root.OwnerID.String != delivery.OwnerID {
		return pgx.ErrNoRows
	}
	ownerCtx := context.WithValue(ctx, authContextKey{}, requestAuth{
		claims: &gatewayClaims{
			UserID:         delivery.OwnerID,
			OrganizationID: access.organizationID,
			WorkspaceID:    access.workspaceID,
		},
		userID:         delivery.OwnerID,
		actorID:        delivery.OwnerID,
		actorType:      requestActorUser,
		organizationID: access.organizationID,
		workspaceID:    access.workspaceID,
	})
	_, apiErr := s.resolveAgentAccess(ownerCtx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		if apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound {
			return pgx.ErrNoRows
		}
		return apiErr
	}
	return nil
}

func (s *Service) repairPrivateChats(ctx context.Context, cursor string) (string, error) {
	rows, err := s.queries.GatewayPrivateChatRoots(ctx, cursor)
	if err != nil {
		return cursor, err
	}
	if len(rows) == 0 {
		return "", nil
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return cursor, nil
		}
		root := row.ChatSession
		cursor = root.WorkspaceID + "/" + root.AgentName + "/" + root.SessionID
		access := resourceAccess{
			workspaceID:    root.WorkspaceID,
			organizationID: row.OrganizationID,
			namespace:      row.Namespace,
		}
		err := s.authorizeWorkflowDelivery(ctx, access, root.AgentName, &agentzv1alpha1.WorkflowDelivery{
			SessionID:  root.SessionID,
			OwnerID:    root.OwnerID.String,
			Generation: root.Generation,
		})
		denied := errors.Is(err, pgx.ErrNoRows)

		if !root.Deleting && !denied {
			continue
		}
		err = s.cleanPrivateChat(ctx, access, root)
		if err != nil {
			slog.ErrorContext(ctx, "clean private conversation", "session", root.SessionID, "error", err)
		}
	}
	return cursor, nil
}

func (s *Service) cleanPrivateChat(ctx context.Context, access resourceAccess, root gatewaydb.ChatSession) error {
	release, err := s.lockChatInputs(ctx, root.WorkspaceID, root.AgentName, root.SessionID, "")
	if err != nil {
		return err
	}
	defer release()
	if !root.Deleting {
		_, err = s.queries.GatewayDeletePrivateChat(ctx, gatewaydb.GatewayDeletePrivateChatParams{
			WorkspaceID: root.WorkspaceID,
			AgentName:   root.AgentName,
			SessionID:   root.SessionID,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	s.notifyChatInput(ctx, gatewaydb.ChatInput{
		WorkspaceID: root.WorkspaceID,
		AgentName:   root.AgentName,
		SessionID:   root.SessionID,
	})
	schedules := &agentzv1alpha1.WorkflowScheduleList{}
	if err := s.k8sClient.List(ctx, schedules, ctrlclient.InNamespace(access.namespace)); err != nil {
		return err
	}
	for i := range schedules.Items {
		schedule := &schedules.Items[i]
		bound := schedule.Spec.Delivery != nil && schedule.Spec.Delivery.SessionID == root.SessionID
		if schedule.Spec.AgentName != root.AgentName || !bound {
			continue
		}
		if err := s.k8sClient.Delete(ctx, schedule); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	runs := &agentzv1alpha1.WorkflowRunList{}
	if err := s.k8sClient.List(ctx, runs, ctrlclient.InNamespace(access.namespace)); err != nil {
		return err
	}
	for i := range runs.Items {
		run := &runs.Items[i]
		bound := run.Spec.Delivery != nil && run.Spec.Delivery.SessionID == root.SessionID
		if run.Spec.AgentName != root.AgentName || !bound {
			continue
		}
		if !run.Status.Phase.Terminal() {
			if err := s.k8sClient.Delete(ctx, run); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
	}
	client, err := s.agentClient(ctx, access.namespace, root.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	aborted, err := client.SessionAbortWithResponse(ctx, root.AgentName, root.SessionID, nil)
	if err != nil {
		return err
	}
	if aborted.StatusCode() != http.StatusOK && aborted.StatusCode() != http.StatusNotFound {
		return fmt.Errorf("abort private conversation: %s", aborted.Status())
	}
	deleted, err := client.SessionDeleteWithResponse(ctx, root.AgentName, root.SessionID, nil)
	if err != nil {
		return err
	}
	if deleted.StatusCode() != http.StatusOK && deleted.StatusCode() != http.StatusNotFound {
		return fmt.Errorf("delete private conversation: %s", deleted.Status())
	}
	return s.queries.GatewayFinishPrivateChatCleanup(ctx, gatewaydb.GatewayFinishPrivateChatCleanupParams{
		WorkspaceID: root.WorkspaceID,
		AgentName:   root.AgentName,
		SessionID:   root.SessionID,
	})
}
