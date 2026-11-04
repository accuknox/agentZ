package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

// chatInputAccess resolves the target on every admission, including worker
// admissions after the author's browser and bearer token have gone away.
func (s *Service) chatInputAccess(ctx context.Context, agent, session string) (resourceAccess, string, string, error) {
	access, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		return access, "", "", apiErr
	}
	if _, _, err := s.authorizeChat(ctx, access, agent, session); err != nil {
		return access, "", "", err
	}
	workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
		ID:             access.workspaceID,
		OrganizationID: access.organizationID,
	})
	if err != nil {
		return access, "", "", err
	}
	if workspace.Type == gatewaydb.WorkspaceTypeCoding {
		row, err := s.resolveCodingSession(ctx, access, agent, session)
		if err != nil {
			return access, "", "", err
		}
		project, tree := row.CodingProject, row.CodingWorktree
		if project.Deleting || tree.Deleting || !tree.Ready {
			return access, "", "", errors.New("checkout is unavailable")
		}
		return access, "/home/agentz/" + tree.Directory, project.ID, nil
	}
	client, err := s.agentClient(ctx, access.namespace, agent, s.outboundHTTP)
	if err != nil {
		return access, "", "", err
	}
	result, err := client.SessionGetWithResponse(ctx, agent, session, nil)
	if err != nil {
		return access, "", "", err
	}
	if result.JSON200 == nil {
		return access, "", "", pgx.ErrNoRows
	}
	return access, result.JSON200.Directory, "", nil
}

// lockChatInputs serializes provider admission across replicas. Coding takes
// its project lock first, matching checkout mutations. No transaction spans IO.
func (s *Service) lockChatInputs(ctx context.Context, workspace, agent, session, project string) (release func(), err error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	releases := make([]func(), 0, 3)
	unlock := func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}
	defer func() {
		if err != nil {
			unlock()
		}
	}()
	root, err := s.queries.GatewayChatRoot(ctx, gatewaydb.GatewayChatRootParams{
		WorkspaceID: workspace,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if project != "" {
		q, release, err := lockGatewayResource(ctx, s.lockDB, project, true)
		if err != nil {
			return nil, err
		}
		releases = append(releases, release)
		ctx = context.WithValue(ctx, gatewayLockKey{}, q)
	}
	if root.SessionID != "" && root.SessionID != session {
		_, release, err := lockGatewayResource(ctx, s.controlDB,
			"session-admission/"+workspace+"/"+agent+"/"+root.SessionID, false)
		if err != nil {
			return nil, err
		}
		releases = append(releases, release)
		root, err = s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
			WorkspaceID: workspace,
			AgentName:   agent,
			SessionID:   root.SessionID,
		})
		if err != nil {
			return nil, err
		}
		if root.Deleting {
			return nil, pgx.ErrNoRows
		}
	}
	_, release, err = lockGatewayResource(ctx, s.controlDB,
		"session-admission/"+workspace+"/"+agent+"/"+session, false)
	if err != nil {
		return nil, err
	}
	releases = append(releases, release)
	return unlock, nil
}

func chatInputView(row gatewaydb.ChatInput) (gatewayapi.ChatInput, error) {
	result := gatewayapi.ChatInput{
		Id:        row.ID,
		Author:    gatewayapi.ResourceActor{Id: row.AuthorID, Name: &row.AuthorName},
		Delivery:  gatewayapi.ChatInputDelivery(row.Delivery),
		State:     gatewayapi.ChatInputState(row.State),
		Revision:  row.Revision,
		CreatedAt: row.CreatedAt,
		Error:     row.Error,
	}
	if row.MessageID != "" {
		result.MessageId = &row.MessageID
	}
	err := json.Unmarshal(row.Content, &result.Content)
	return result, err
}

// ListChatInputs returns the shared queue and only the caller's recovered drafts.
func (s *Service) ListChatInputs(w http.ResponseWriter, r *http.Request, agent string, session string) {
	access, _, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get chat", err))
		return
	}
	rows, err := s.queries.GatewayListChatInputs(r.Context(), gatewaydb.GatewayListChatInputsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
		AuthorID:    access.userID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result := gatewayapi.ChatInputs{Items: make([]gatewayapi.ChatInput, 0, len(rows))}
	result.Stopping, err = s.queries.GatewayChatInputsStopping(
		r.Context(),
		gatewaydb.GatewayChatInputsStoppingParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		},
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	for _, row := range rows {
		item, err := chatInputView(row)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		result.Items = append(result.Items, item)
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func validateChatInput(input gatewayapi.ChatInputContent) error {
	if strings.TrimSpace(input.Text) == "" && len(input.Attachments) == 0 {
		return errors.New("message cannot be empty")
	}
	for _, file := range input.Attachments {
		// Uploaded paths are relative to the agent home, just like the file API.
		escapesHome := file.Path == ".." || strings.HasPrefix(file.Path, "../")
		if path.IsAbs(file.Path) || path.Clean(file.Path) != file.Path || escapesHome {
			return errors.New("attachment path must be relative to the agent home")
		}
	}
	return nil
}

// SubmitChatInput durably records intent before acknowledging the composer.
func (s *Service) SubmitChatInput(w http.ResponseWriter, r *http.Request, agent string, session string) {
	var input gatewayapi.ChatInputRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	if err := validateChatInput(input.Content); err != nil {
		apiutil.WriteError(
			w, r,
			apiutil.NewError(http.StatusBadRequest, "invalid_input", err.Error(), err),
		)
		return
	}
	access, directory, project, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get chat", err))
		return
	}
	release, err := s.lockChatInputs(r.Context(), access.workspaceID, agent, session, project)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("submit message", err))
		return
	}
	defer release()
	raw, err := json.Marshal(input.Content)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	auth, _ := requestAuthState(r.Context())
	row, err := s.queries.GatewayCreateChatInput(r.Context(), gatewaydb.GatewayCreateChatInputParams{
		ID:             input.Id,
		WorkspaceID:    access.workspaceID,
		AgentName:      agent,
		SessionID:      session,
		OrganizationID: access.organizationID,
		AuthorID:       access.userID,
		AuthorName:     auth.actorName,
		Directory:      directory,
		Content:        raw,
		Delivery:       string(input.Delivery),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(
			w, r,
			apiutil.NewError(
				http.StatusConflict,
				"input_conflict",
				"This request ID belongs to another message.",
				err,
			),
		)
		return
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	s.notifyChatInput(r.Context(), row)
	result, err := chatInputView(row)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusAccepted, result)
}

// UpdateChatInput changes an unsent message under authorship and revision checks.
func (s *Service) UpdateChatInput(w http.ResponseWriter, r *http.Request, agent string, session string, id string) {
	var input gatewayapi.ChatInputUpdate
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	inputID, err := uuid.Parse(id)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get message", pgx.ErrNoRows))
		return
	}
	access, _, project, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get chat", err))
		return
	}
	release, err := s.lockChatInputs(r.Context(), access.workspaceID, agent, session, project)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("update message", err))
		return
	}
	defer release()
	row, err := s.queries.GatewayGetChatInput(r.Context(), gatewaydb.GatewayGetChatInputParams{
		ID:          inputID,
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil || row.AuthorID != access.userID || row.Origin != gatewaydb.ChatInputOriginUser {
		apiutil.WriteError(w, r, mapGatewayStoreError("get message", pgx.ErrNoRows))
		return
	}
	editable := true
	switch gatewayapi.ChatInputState(row.State) {
	case gatewayapi.ChatInputStateSending, gatewayapi.ChatInputStateDelivered,
		gatewayapi.ChatInputStateRemoved:
		editable = false
	}
	if row.Revision != input.Revision || row.MessageID != "" || !editable {
		apiutil.WriteError(
			w, r,
			apiutil.NewError(
				http.StatusConflict,
				"input_changed",
				"This message changed or is already being sent.",
				nil,
			),
		)
		return
	}
	switch input.Action {
	case gatewayapi.ChatInputUpdateActionEdit:
		if input.Content == nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_input", "Edited content is required.", nil))
			return
		}
		if err := validateChatInput(*input.Content); err != nil {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_input", err.Error(), err))
			return
		}
		var content gatewayapi.ChatInputContent
		if err := json.Unmarshal(row.Content, &content); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		content.Text = input.Content.Text
		content.Attachments = input.Content.Attachments
		row.Content, err = json.Marshal(content)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	case gatewayapi.ChatInputUpdateActionSteer:
		if row.State != string(gatewayapi.ChatInputStateQueued) {
			apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "input_changed", "This message is no longer queued.", nil))
			return
		}
		row.Delivery = string(gatewayapi.ChatInputDeliverySteer)
	case gatewayapi.ChatInputUpdateActionRetry:
		row.Resume = true
		row.State = string(gatewayapi.ChatInputStateQueued)
	case gatewayapi.ChatInputUpdateActionRemove:
		row.State = string(gatewayapi.ChatInputStateRemoved)
	}
	row.Error = ""
	row, err = s.saveChatInput(r.Context(), row)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("update message", err))
		return
	}
	result, err := chatInputView(row)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// stopOpenCodeSession bars dispatch while cancelling through the native API.
func (s *Service) stopOpenCodeSession(w http.ResponseWriter, r *http.Request, route *opencodeRouteMatch, agent string) {
	session := route.Params["sessionID"]
	interrupt := route.ID == "v2.session.interrupt"
	access, directory, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get chat", err))
		return
	}
	ctx, closeLocks, err := gatewayLocks(r.Context(), s.controlDB)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("stop chat", err))
		return
	}
	if closeLocks != nil {
		defer closeLocks()
	}
	r = r.WithContext(ctx)
	release, err := s.lockChatInputs(r.Context(), access.workspaceID, agent, session, "")
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("stop chat", err))
		return
	}
	defer release()
	if _, _, err := s.authorizeChat(r.Context(), access, agent, session); err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("stop conversation", err))
		return
	}

	if err := s.settleChatStop(r.Context(), access, agent, session, directory, interrupt); err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("stop conversation", err))
		return
	}
	if interrupt {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, true)
}

// settleChatStop reconciles durable cancellation intent while the caller holds the admission lock.
func (s *Service) settleChatStop(ctx context.Context, access resourceAccess, agent, session, directory string, interrupt bool) error {
	indexed, err := s.queries.GatewayChatSessionExists(ctx, gatewaydb.GatewayChatSessionExistsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil {
		return err
	}
	params := gatewaydb.GatewayStopChatInputsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
		Stopping:    true,
	}
	if indexed {
		err = s.queries.GatewayStopChatInputs(ctx, params)
		if err != nil {
			return err
		}
	}
	client, err := s.agentClient(ctx, access.namespace, agent, s.outboundHTTP)
	if err != nil {
		return err
	}
	var rows []gatewaydb.ChatInput
	if indexed {
		rows, err = s.queries.GatewayListChatInputs(ctx, gatewaydb.GatewayListChatInputsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
			AuthorID:    access.userID,
		})
		if err != nil {
			return err
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	settled := false
	stopped := false
	for time.Now().Before(deadline) {
		admitted := true
		for i, row := range rows {
			if row.MessageID == "" || row.State == string(gatewayapi.ChatInputStateDelivered) {
				continue
			}
			row, err = s.reconcileChatInput(ctx, client, directory, row)
			if err != nil {
				admitted = false
				break
			}
			rows[i] = row
			if row.MessageID != "" && row.State != string(gatewayapi.ChatInputStateDelivered) {
				admitted = false
				break
			}
		}
		if interrupt {
			response, err := client.V2SessionInterruptWithResponse(ctx, agent, session)
			if err != nil || response.StatusCode() != http.StatusNoContent {
				break
			}
		}
		// The v2 coordinator does not own legacy prompt executions. Its
		// interrupt must also cancel those through the directory-scoped API.
		response, err := client.SessionAbortWithResponse(
			ctx, agent, session,
			&gatewayapi.SessionAbortParams{Directory: &directory},
		)
		if err != nil || response.JSON200 == nil || !*response.JSON200 {
			break
		}
		status, err := client.SessionStatusWithResponse(
			ctx,
			agent,
			&gatewayapi.SessionStatusParams{Directory: &directory},
		)
		if err != nil || status.JSON200 == nil {
			break
		}
		idle := true
		if value, ok := (*status.JSON200)[session]; ok {
			state, err := value.Discriminator()
			idle = err == nil && state == string(gatewayapi.Idle)
		}
		active, err := s.queries.GatewayResourceBusy(
			ctx,
			"session-execution/"+access.workspaceID+"/"+agent+"/"+session,
		)
		if err != nil {
			break
		}
		admitted = admitted && !active
		// Repeat the abort after observing admission. A prompt_async receipt
		// can precede persistence, and aborting before that would miss the run.
		if admitted && idle && settled {
			stopped = true
			break
		}
		settled = admitted && idle
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-poll.C:
		}
	}
	if !stopped {
		message := "Could not confirm the agent stopped; retry Stop."
		if indexed {
			message = "Could not confirm the agent stopped. Queued messages are held; retry Stop."
		}
		return apiutil.NewError(http.StatusBadGateway, "stop_failed", message, nil)
	}

	if indexed {
		err = s.queries.GatewayRecoverChatInputs(ctx, gatewaydb.GatewayRecoverChatInputsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		})
		if err != nil {
			return err
		}
		params.Stopping = false
		err = s.queries.GatewayStopChatInputs(ctx, params)
		if err != nil {
			return err
		}
	}
	resolved, err := s.resolver.resolveAgent(ctx, access.namespace, agent)
	if err != nil {
		return err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return err
	}
	query := target.Query()
	query.Set("directory", directory)
	target.RawQuery = query.Encode()
	err = s.refreshOpenCodeStatus(ctx, target, access.workspaceID, agent)
	if err != nil {
		return err
	}
	if indexed {
		s.notifyChatInput(
			ctx,
			gatewaydb.ChatInput{
				WorkspaceID: access.workspaceID,
				AgentName:   agent,
				SessionID:   session,
			},
		)
	}
	return nil
}

func (s *Service) notifyChatInput(ctx context.Context, row gatewaydb.ChatInput) {
	err := s.queries.GatewayNotifyChatInputs(ctx, gatewaydb.GatewayNotifyChatInputsParams{
		WorkspaceID: row.WorkspaceID,
		AgentName:   row.AgentName,
		SessionID:   pgtype.Text{String: row.SessionID, Valid: true},
	})
	if err != nil {
		slog.ErrorContext(ctx, "notify chat input", "error", err)
	}
	select {
	case s.chatInputWake <- struct{}{}:
	default:
	}
}

func (s *Service) saveChatInput(ctx context.Context, row gatewaydb.ChatInput) (gatewaydb.ChatInput, error) {
	saved, err := s.queries.GatewayUpdateChatInput(ctx, gatewaydb.GatewayUpdateChatInputParams{
		ID:        row.ID,
		Content:   row.Content,
		Delivery:  row.Delivery,
		Revision:  row.Revision,
		State:     row.State,
		Error:     row.Error,
		MessageID: row.MessageID,
		Resume:    row.Resume,
	})
	if err == nil {
		s.notifyChatInput(ctx, saved)
	}
	return saved, err
}

func (s *Service) runChatInputs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	cursor := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.chatInputWake:
		case <-ticker.C:
		}
		rows, err := s.queries.GatewayPendingChatInputs(ctx, cursor)
		if err != nil {
			slog.ErrorContext(ctx, "read pending chat inputs", "error", err)
			continue
		}
		if len(rows) == 0 {
			cursor = ""
		}
		var wg sync.WaitGroup
		slots := make(chan struct{}, 4)
		for _, row := range rows {
			cursor = row.WorkspaceID + "/" + row.AgentName + "/" + row.SessionID
			state := gatewayapi.ChatInputState(row.State)
			if row.Origin == gatewaydb.ChatInputOriginUser && state == gatewayapi.ChatInputStateFailed && row.MessageID == "" {
				continue
			}
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				wg.Wait()
				return
			}
			wg.Go(func() {
				defer func() { <-slots }()
				err := s.deliverChatInput(ctx, row)
				if err != nil && ctx.Err() == nil {
					slog.ErrorContext(
						ctx, "deliver chat input",
						"input", row.ID, "error", err,
					)
				}
			})
		}
		wg.Wait()
	}
}

// reconcileChatInput runs under the conversation lock so retry and Stop cannot
// release an input while another gateway is still submitting it.
func (s *Service) reconcileChatInput(ctx context.Context, client *gatewayapi.ClientWithResponses, directory string, row gatewaydb.ChatInput) (gatewaydb.ChatInput, error) {
	params := &gatewayapi.SessionMessageParams{Directory: &directory}
	message, err := client.SessionMessageWithResponse(
		ctx, row.AgentName, row.SessionID, row.MessageID, params,
	)
	if err != nil {
		return row, err
	}
	if message.JSON200 != nil && row.Origin != gatewaydb.ChatInputOriginUser {
		found := false
		for _, part := range message.JSON200.Parts {
			kind, err := part.Discriminator()
			if err != nil {
				return row, err
			}
			if kind != "text" {
				continue
			}
			text, err := part.AsOpencodeTextPart()
			if err != nil {
				return row, err
			}
			found = found || text.Id == row.PartID.String
		}
		if !found {
			var content gatewayapi.ChatInputContent
			if err := json.Unmarshal(row.Content, &content); err != nil {
				return row, err
			}
			text := gatewayapi.OpencodeTextPart{
				Id:        row.PartID.String,
				MessageID: row.MessageID,
				SessionID: row.SessionID,
				Type:      gatewayapi.OpencodeTextPartTypeText,
				Text:      content.Text,
				Synthetic: new(true),
				Metadata:  &map[string]any{"agentz.dev/input-id": row.ID.String()},
			}
			var part gatewayapi.OpencodePart
			if err := part.FromOpencodeTextPart(text); err != nil {
				return row, err
			}
			repaired, err := client.PartUpdateWithResponse(ctx, row.AgentName, row.SessionID, row.MessageID,
				row.PartID.String, &gatewayapi.PartUpdateParams{Directory: &directory}, part)
			if err != nil {
				return row, err
			}
			if repaired.JSON200 == nil {
				return row, fmt.Errorf("repair background part: %s", repaired.Status())
			}
		}
	}

	if message.JSON200 != nil {
		row.State = string(gatewayapi.ChatInputStateDelivered)
		row.Error = ""
		return s.saveChatInput(ctx, row)
	}
	if message.StatusCode() != http.StatusNotFound {
		return row, fmt.Errorf("could not confirm admission: %s", message.Status())
	}
	// prompt_async acknowledges before persistence. A missing message alone
	// is not enough to release its ID, even after a gateway restart.
	if time.Since(row.UpdatedAt) < time.Minute {
		return row, nil
	}
	status, err := client.SessionStatusWithResponse(
		ctx, row.AgentName,
		&gatewayapi.SessionStatusParams{Directory: &directory},
	)
	if err != nil {
		return row, err
	}
	if status.JSON200 == nil {
		return row, errors.New("could not read agent status")
	}
	if value, ok := (*status.JSON200)[row.SessionID]; ok {
		state, err := value.Discriminator()
		if err != nil {
			return row, err
		}
		if state != string(gatewayapi.Idle) {
			return row, nil
		}
	}
	active, err := s.queries.GatewayResourceBusy(
		ctx, "session-execution/"+row.WorkspaceID+"/"+row.AgentName+"/"+row.SessionID,
	)
	if err != nil || active {
		return row, err
	}
	// Recheck after status and execution leases to catch late persistence.
	message, err = client.SessionMessageWithResponse(
		ctx, row.AgentName, row.SessionID, row.MessageID, params,
	)
	if err != nil {
		return row, err
	}
	switch {
	case message.JSON200 != nil:
		row.State = string(gatewayapi.ChatInputStateDelivered)
		row.Error = ""
	case message.StatusCode() == http.StatusNotFound:
		row.State = string(gatewayapi.ChatInputStateFailed)
		row.MessageID = ""
		row.Error = "The agent did not receive this message. Retry or remove it."
		if row.Origin != gatewaydb.ChatInputOriginUser {
			row.State = string(gatewayapi.ChatInputStateQueued)
			row.Error = ""
		}
	default:
		return row, fmt.Errorf("could not confirm admission: %s", message.Status())
	}
	return s.saveChatInput(ctx, row)
}

func (s *Service) deliverChatInput(ctx context.Context, row gatewaydb.ChatInput) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if row.Origin != gatewaydb.ChatInputOriginUser {
		owner, err := s.queries.GatewayGetAgentOwner(ctx, gatewaydb.GatewayGetAgentOwnerParams{
			OrganizationID: row.OrganizationID,
			WorkspaceID:    row.WorkspaceID,
			AgentName:      row.AgentName,
		})
		if err != nil {
			return err
		}
		row.AuthorID = owner.OwnerUserID
	}
	claims := gatewayClaims{
		UserID:         row.AuthorID,
		OrganizationID: row.OrganizationID,
		WorkspaceID:    row.WorkspaceID,
	}
	ctx = context.WithValue(ctx, authContextKey{}, requestAuth{
		claims:         &claims,
		userID:         row.AuthorID,
		userName:       row.AuthorName,
		actorID:        row.AuthorID,
		actorName:      row.AuthorName,
		actorType:      requestActorUser,
		workspaceID:    row.WorkspaceID,
		organizationID: row.OrganizationID,
	})
	access, directory, project, err := s.chatInputAccess(ctx, row.AgentName, row.SessionID)
	if err != nil {
		if row.Origin != gatewaydb.ChatInputOriginUser {
			return err
		}
		var denied *apiutil.APIError
		forbidden := errors.As(err, &denied) && denied.Status == http.StatusForbidden
		if errors.Is(err, pgx.ErrNoRows) || forbidden {
			release, lockErr := s.lockChatInputs(
				ctx,
				row.WorkspaceID,
				row.AgentName,
				row.SessionID,
				"",
			)
			if lockErr != nil {
				return lockErr
			}
			defer release()
			if _, _, err := s.authorizeChat(ctx, access, row.AgentName, row.SessionID); err != nil {
				return err
			}

			row.State = string(gatewayapi.ChatInputStateFailed)
			row.Error = "The author no longer has access to this conversation or its agent. Restore access before retrying."
			_, saveErr := s.saveChatInput(ctx, row)
			return saveErr
		}
		return err
	}
	release, err := s.lockChatInputs(ctx, row.WorkspaceID, row.AgentName, row.SessionID, project)
	if err != nil {
		return nil
	}
	defer release()
	row, err = s.queries.GatewayGetChatInput(ctx, gatewaydb.GatewayGetChatInputParams{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		AgentName:   row.AgentName,
		SessionID:   row.SessionID,
	})
	if err != nil {
		return err
	}
	if row.Origin != gatewaydb.ChatInputOriginUser {
		root, eligible, err := s.authorizeChat(ctx, access, row.AgentName, row.SessionID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err != nil || !eligible || root.Generation != row.Generation || row.CompletedAt.Valid {
			if row.CompletedAt.Valid {
				return nil
			}
			_, saveErr := s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
				ID:    row.ID,
				Error: "The destination is no longer available",
			})
			return saveErr
		}
	}
	finished := row.State == "delivered" || row.State == "failed" && row.MessageID == ""
	if row.Origin != gatewaydb.ChatInputOriginUser && finished {
		return s.completeBackgroundInput(ctx, access, directory, row)
	}
	state := gatewayapi.ChatInputState(row.State)
	switch state {
	case gatewayapi.ChatInputStateQueued, gatewayapi.ChatInputStateSending:
	case gatewayapi.ChatInputStateFailed:
		if row.MessageID == "" {
			return nil
		}
	default:
		return nil
	}
	stopping, err := s.queries.GatewayChatInputsStopping(ctx, gatewaydb.GatewayChatInputsStoppingParams{
		WorkspaceID: row.WorkspaceID,
		AgentName:   row.AgentName,
		SessionID:   row.SessionID,
	})
	if err != nil {
		return err
	}
	if stopping {
		return s.settleChatStop(ctx, access, row.AgentName, row.SessionID, directory, false)
	}
	client, err := s.agentClient(ctx, access.namespace, row.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	if row.MessageID != "" {
		_, err = s.reconcileChatInput(ctx, client, directory, row)
		return err
	}

	head, err := s.queries.GatewayHeadChatInput(ctx, gatewaydb.GatewayHeadChatInputParams{
		WorkspaceID: row.WorkspaceID,
		AgentName:   row.AgentName,
		SessionID:   row.SessionID,
	})
	if err != nil {
		return err
	}
	if head.ID != row.ID {
		return nil
	}
	// A queued follow-up must never be injected into an unfinished turn. Read
	// history as well as status: prompt_async can acknowledge before busy appears.
	status, err := client.SessionStatusWithResponse(
		ctx,
		row.AgentName,
		&gatewayapi.SessionStatusParams{Directory: &directory},
	)
	if err != nil {
		return err
	}
	if status.JSON200 == nil {
		return errors.New("could not read agent status")
	}
	busy := false
	if value, ok := (*status.JSON200)[row.SessionID]; ok {
		state, err := value.Discriminator()
		if err != nil {
			return err
		}
		busy = state != string(gatewayapi.Idle)
	}
	permissions, err := client.PermissionListWithResponse(
		ctx,
		row.AgentName,
		&gatewayapi.PermissionListParams{Directory: &directory},
	)
	if err != nil {
		return err
	}
	if permissions.JSON200 == nil {
		return errors.New("could not read pending permissions")
	}
	for _, request := range *permissions.JSON200 {
		if request.SessionID == row.SessionID {
			return nil
		}
	}
	questions, err := client.QuestionListWithResponse(
		ctx,
		row.AgentName,
		&gatewayapi.QuestionListParams{Directory: &directory},
	)
	if err != nil {
		return err
	}
	if questions.JSON200 == nil {
		return errors.New("could not read pending questions")
	}
	for _, request := range *questions.JSON200 {
		if request.SessionID == row.SessionID {
			return nil
		}
	}
	if gatewayapi.ChatInputDelivery(row.Delivery) == gatewayapi.ChatInputDeliveryQueue {
		if busy {
			return nil
		}
		limit := 200
		history, err := client.SessionMessagesWithResponse(
			ctx,
			row.AgentName,
			row.SessionID,
			&gatewayapi.SessionMessagesParams{Directory: &directory, Limit: &limit},
		)
		if err != nil {
			return err
		}
		if history.JSON200 == nil {
			return errors.New("could not verify the previous turn")
		}
		var user gatewayapi.OpencodeUserMessage
		var assistant gatewayapi.OpencodeAssistantMessage
		for _, message := range *history.JSON200 {
			role, err := message.Info.Discriminator()
			if err != nil {
				return err
			}
			switch role {
			case "user":
				candidate, err := message.Info.AsOpencodeUserMessage()
				if err != nil {
					return err
				}
				user = candidate
			case "assistant":
				assistant, err = message.Info.AsOpencodeAssistantMessage()
				if err != nil {
					return err
				}
			}
		}
		unfinished := user.Id != "" && (assistant.ParentID != user.Id || assistant.Time.Completed == nil)
		if user.Id != "" && !unfinished {
			if assistant.Error != nil && !row.Resume && row.Origin == gatewaydb.ChatInputOriginUser {
				row.State = string(gatewayapi.ChatInputStateFailed)
				row.Error = "The previous run stopped with an error. Remove or retry this message to continue."
				_, err = s.saveChatInput(ctx, row)
				return err
			}
			finished := assistant.Finish != nil && *assistant.Finish != "tool-calls" && *assistant.Finish != "unknown"
			unfinished = !row.Resume && assistant.Error == nil && !finished
		}
		if unfinished {
			// An interrupted tool turn can remain idle without a final response.
			// Allow new work only after persistence settles and execution leases drain.
			last := time.UnixMilli(user.Time.Created)
			if assistant.Time.Completed != nil && assistant.ParentID == user.Id {
				last = time.UnixMilli(int64(*assistant.Time.Completed))
			}
			if time.Since(last) < time.Minute {
				return nil
			}
			active, err := s.queries.GatewayResourceBusy(ctx,
				"session-execution/"+row.WorkspaceID+"/"+row.AgentName+"/"+row.SessionID)
			if err != nil || active {
				return err
			}
		}
	}
	var content gatewayapi.ChatInputContent
	if err := json.Unmarshal(row.Content, &content); err != nil {
		return err
	}
	body := gatewayapi.SessionPromptAsyncJSONRequestBody{
		Agent:   content.Agent,
		Variant: content.Variant,
		Model: &gatewayapi.OpencodePromptModel{
			ProviderID: content.Model.ProviderID,
			ModelID:    content.Model.ModelID,
		},
		Parts: make([]gatewayapi.OpencodePromptPartInput, 0, len(content.Attachments)+1),
	}
	if row.Origin != gatewaydb.ChatInputOriginUser {
		session, err := client.SessionGetWithResponse(ctx, row.AgentName, row.SessionID, nil)
		if err != nil {
			return err
		}
		if session.JSON200 == nil || session.JSON200.Model == nil {
			return errors.New("cannot resolve the conversation model")
		}
		body.Agent = session.JSON200.Agent
		body.Model = &gatewayapi.OpencodePromptModel{
			ProviderID: session.JSON200.Model.ProviderID,
			ModelID:    session.JSON200.Model.Id,
		}
		body.Variant = session.JSON200.Model.Variant
		instruction := workflowNotificationInstruction
		body.System = &instruction
	}
	for _, file := range content.Attachments {
		filePath, _ := json.Marshal("/home/agentz/" + file.Path)
		filename, _ := json.Marshal(file.Filename)
		mime, _ := json.Marshal(file.MediaType)
		synthetic := true
		text := gatewayapi.OpencodeTextPartInput{
			Type:      gatewayapi.OpencodeTextPartInputTypeText,
			Synthetic: &synthetic,
			Metadata:  &map[string]any{"agentz_attachment": file},
			Text: fmt.Sprintf(
				`<attached_file>
path: %s
name: %s
media_type: %s
size: %d bytes
The path is exact. Copy it verbatim; do not shorten or remove directories.
Use analyze_file when you need the contents of this file.
</attached_file>`,
				filePath, filename, mime, file.Size,
			),
		}
		var part gatewayapi.OpencodePromptPartInput
		if err := part.FromOpencodeTextPartInput(text); err != nil {
			return err
		}
		body.Parts = append(body.Parts, part)
	}
	var part gatewayapi.OpencodePromptPartInput
	text := gatewayapi.OpencodeTextPartInput{
		Type: gatewayapi.OpencodeTextPartInputTypeText,
		Text: strings.TrimSpace(content.Text),
	}
	if row.Origin != gatewaydb.ChatInputOriginUser {
		synthetic := true
		text.Synthetic = &synthetic
		text.Id = &row.PartID.String
	}
	if err := part.FromOpencodeTextPartInput(text); err != nil {
		return err
	}
	body.Parts = append(body.Parts, part)
	// Match OpenCode's ascending timestamp prefix, but allocate at admission,
	// since a follow-up may have waited while later steers were submitted.
	row.MessageID = fmt.Sprintf(
		"msg_%012x%s",
		(time.Now().UnixMilli()<<12)&0xffffffffffff,
		rand.Text()[:14],
	)
	body.MessageID = &row.MessageID
	auth, _ := requestAuthState(ctx)
	promptAuth := auth
	if row.Origin != gatewaydb.ChatInputOriginUser {
		promptAuth.actorType = requestActorSystem
		promptAuth.actorID = string(row.Origin)
		promptAuth.actorName = "AgentZ"
	}
	body.Parts, err = attributePrompt(body.Parts, promptAuth, row.ID.String())
	if err != nil {
		return err
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	row.State = string(gatewayapi.ChatInputStateSending)
	row, err = s.saveChatInput(ctx, row)
	if err != nil {
		return err
	}
	response, err := client.SessionPromptAsyncWithBodyWithResponse(
		ctx, row.AgentName, row.SessionID,
		&gatewayapi.SessionPromptAsyncParams{Directory: &directory},
		"application/json", bytes.NewReader(raw),
	)
	// Keep uncertain admission for reconciliation.
	if err != nil {
		return err
	}
	statusCode := response.StatusCode()
	unexpected := statusCode < 400 && statusCode != http.StatusNoContent
	if statusCode >= 500 || unexpected {
		return fmt.Errorf("agent admission is uncertain: %s", response.Status())
	}
	if statusCode != http.StatusNoContent {
		row.State = string(gatewayapi.ChatInputStateFailed)
		row.MessageID = ""
		row.Error = fmt.Sprintf(
			"The agent rejected this message (%d). Remove or retry it.",
			statusCode,
		)
		_, err = s.saveChatInput(ctx, row)
		return err
	}
	if row.Origin != gatewaydb.ChatInputOriginUser {
		return nil
	}
	route := &opencodeRouteMatch{
		Method: http.MethodPost,
		ID:     "session.prompt_async",
		Params: map[string]string{"sessionID": row.SessionID},
	}
	return s.recordOpenCodePrompt(ctx, route, auth, row.WorkspaceID, row.AgentName)
}
