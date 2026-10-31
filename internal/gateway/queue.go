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
func (s *Service) lockChatInputs(ctx context.Context, workspace, agent, session, project string) (func(), error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var releaseProject func()
	if project != "" {
		q, release, err := lockGatewayResource(ctx, s.lockDB, project, true)
		if err != nil {
			return nil, err
		}
		releaseProject = release
		ctx = context.WithValue(ctx, gatewayLockKey{}, q)
	}
	_, release, err := lockGatewayResource(
		ctx,
		s.controlDB,
		"session-admission/"+workspace+"/"+agent+"/"+session,
		false,
	)
	if err != nil {
		if releaseProject != nil {
			releaseProject()
		}
		return nil, err
	}
	return func() {
		release()
		if releaseProject != nil {
			releaseProject()
		}
	}, nil
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

// UpdateChatInput removes or retries a message with authorship and revision checks.
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

	indexed, err := s.queries.GatewayChatSessionExists(r.Context(), gatewaydb.GatewayChatSessionExistsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	params := gatewaydb.GatewayStopChatInputsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
		Stopping:    true,
	}
	if indexed {
		err = s.queries.GatewayStopChatInputs(r.Context(), params)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	canceled, err := s.queries.GatewayCancelPulseChecks(r.Context(), gatewaydb.GatewayCancelPulseChecksParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(canceled) > 0 {
		root, getErr := s.queries.GatewayGetChatSession(r.Context(), gatewaydb.GatewayGetChatSessionParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		})
		if getErr != nil {
			apiutil.WriteInternalError(w, r, getErr)
			return
		}
		_, err = s.queries.GatewayUpdatePulse(r.Context(), gatewaydb.GatewayUpdatePulseParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
			OwnerID:     root.OwnerID,
			Paused:      root.PulsePaused,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	client, err := s.agentClient(r.Context(), access.namespace, agent, s.outboundHTTP)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	rows := canceled
	if indexed {
		rows, err = s.queries.GatewayListChatInputs(r.Context(), gatewaydb.GatewayListChatInputsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
			AuthorID:    access.userID,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		rows = append(rows, canceled...)
	}
	deadline := time.Now().Add(10 * time.Second)
	settled := false
	stopped := false
	for time.Now().Before(deadline) {
		admitted := true
		for i, row := range rows {
			if row.MessageID == "" || row.State == string(gatewayapi.ChatInputStateDelivered) {
				continue
			}
			row, err = s.reconcileChatInput(r.Context(), client, directory, row)
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
			response, err := client.V2SessionInterruptWithResponse(r.Context(), agent, session)
			if err != nil || response.StatusCode() != http.StatusNoContent {
				break
			}
		}
		// The v2 coordinator does not own legacy prompt executions. Its
		// interrupt must also cancel those through the directory-scoped API.
		response, err := client.SessionAbortWithResponse(
			r.Context(), agent, session,
			&gatewayapi.SessionAbortParams{Directory: &directory},
		)
		if err != nil || response.JSON200 == nil || !*response.JSON200 {
			break
		}
		status, err := client.SessionStatusWithResponse(
			r.Context(),
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
			r.Context(),
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
		case <-r.Context().Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
	if !stopped {
		message := "Could not confirm the agent stopped; retry Stop."
		if indexed {
			message = "Could not confirm the agent stopped. Queued messages are held; retry Stop."
		}
		apiutil.WriteError(
			w, r,
			apiutil.NewError(
				http.StatusBadGateway,
				"stop_failed",
				message,
				nil,
			),
		)
		return
	}

	if indexed {
		err = s.queries.GatewayRecoverChatInputs(r.Context(), gatewaydb.GatewayRecoverChatInputsParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		params.Stopping = false
		err = s.queries.GatewayStopChatInputs(r.Context(), params)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	resolved, err := s.resolver.resolveAgent(r.Context(), access.namespace, agent)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	query := target.Query()
	query.Set("directory", directory)
	target.RawQuery = query.Encode()
	err = s.refreshOpenCodeStatus(r.Context(), target, access.workspaceID, agent)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if indexed {
		s.notifyChatInput(
			r.Context(),
			gatewaydb.ChatInput{
				WorkspaceID: access.workspaceID,
				AgentName:   agent,
				SessionID:   session,
			},
		)
	}
	if interrupt {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, true)
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
		Revision:  row.Revision,
		State:     row.State,
		Error:     row.Error,
		MessageID: row.MessageID,
		Resume:    row.Resume,
	})
	if err == nil {
		if saved.Origin != gatewaydb.ChatInputOriginUser && saved.State == "failed" && saved.MessageID == "" {
			_, err = s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{ID: saved.ID, Error: saved.Error})
			if err != nil {
				return saved, err
			}
		}
		s.notifyChatInput(ctx, saved)
	}
	return saved, err
}

func (s *Service) runChatInputs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var repaired time.Time
	repairCursor := ""
	var backgroundCursor int64
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.chatInputWake:
		case <-ticker.C:
		}
		if time.Since(repaired) >= 10*time.Second {
			var err error
			repairCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			repairCursor, err = s.repairPrivateChats(repairCtx, repairCursor)
			cancel()
			if err != nil {
				slog.ErrorContext(ctx, "repair private conversations", "error", err)
			}
			repaired = time.Now()
		}
		var err error
		backgroundCtx, cancel := context.WithTimeout(ctx, time.Second)
		backgroundCursor, err = s.runBackgroundChecks(backgroundCtx, backgroundCursor)
		cancel()
		if err != nil {
			slog.ErrorContext(ctx, "reconcile background checks", "error", err)
		}
		rows, err := s.queries.GatewayPendingChatInputs(ctx)
		if err != nil {
			slog.ErrorContext(ctx, "read pending chat inputs", "error", err)
			continue
		}
		var wg sync.WaitGroup
		slots := make(chan struct{}, 4)
		for _, row := range rows {
			state := gatewayapi.ChatInputState(row.State)
			if state == gatewayapi.ChatInputStateFailed && row.MessageID == "" {
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
		var prompt gatewayapi.SessionPromptAsyncJSONRequestBody
		if err := json.Unmarshal(row.Background, &prompt); err != nil {
			return row, err
		}
		for _, expected := range prompt.Parts {
			input, err := expected.AsOpencodeTextPartInput()
			if err != nil {
				return row, err
			}
			if input.Id == nil {
				return row, errors.New("background prompt has no stable part identity")
			}
			verified := false
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
				if text.Id != *input.Id {
					continue
				}
				if text.Text != input.Text {
					_, err := s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
						ID:    row.ID,
						Error: "Background content conflicts with persisted history. It will not be replayed.",
					})
					return row, err
				}
				verified = true
				break
			}
			if verified {
				continue
			}
			synthetic := true
			text := gatewayapi.OpencodeTextPart{
				Id:        *input.Id,
				MessageID: row.MessageID,
				SessionID: row.SessionID,
				Type:      gatewayapi.OpencodeTextPartTypeText,
				Text:      input.Text,
				Synthetic: &synthetic,
				Metadata:  input.Metadata,
			}
			var body gatewayapi.OpencodePart
			if err := body.FromOpencodeTextPart(text); err != nil {
				return row, err
			}
			repaired, err := client.PartUpdateWithResponse(
				ctx, row.AgentName, row.SessionID, row.MessageID, *input.Id, &gatewayapi.PartUpdateParams{Directory: &directory}, body,
			)
			if err != nil {
				return row, err
			}
			if repaired.JSON200 == nil {
				return row, fmt.Errorf("could not repair background part: %s", repaired.Status())
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
	default:
		return row, fmt.Errorf("could not confirm admission: %s", message.Status())
	}
	return s.saveChatInput(ctx, row)
}

func (s *Service) deliverChatInput(ctx context.Context, row gatewaydb.ChatInput) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
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
		root, private, err := s.authorizeChat(ctx, access, row.AgentName, row.SessionID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err != nil || !private || root.Generation != row.Generation || row.CompletedAt.Valid {
			if row.CompletedAt.Valid {
				return nil
			}
			_, saveErr := s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
				ID:    row.ID,
				Error: "The destination is no longer available",
			})
			return saveErr
		}
		if row.Origin == gatewaydb.ChatInputOriginPulse && root.PulsePaused && row.MessageID == "" {
			return nil
		}
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
	if stopping && row.MessageID == "" {
		return nil
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
		contextInputs, err := s.queries.GatewayListChatBackground(ctx, gatewaydb.GatewayListChatBackgroundParams{
			WorkspaceID: row.WorkspaceID,
			AgentName:   row.AgentName,
			SessionID:   row.SessionID,
		})
		if err != nil {
			return err
		}
		contextOnly := make(map[string]bool)
		for _, input := range contextInputs {
			if input.Origin == gatewaydb.ChatInputOriginWorkflowResult && input.State == "delivered" {
				contextOnly[input.MessageID] = true
			}
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
				if !contextOnly[candidate.Id] {
					user = candidate
				}
			case "assistant":
				assistant, err = message.Info.AsOpencodeAssistantMessage()
				if err != nil {
					return err
				}
			}
		}
		if user.Id != "" {
			if assistant.ParentID != user.Id || assistant.Time.Completed == nil {
				return nil
			}
			if assistant.Error != nil && !row.Resume && row.Origin == gatewaydb.ChatInputOriginUser {
				row.State = string(gatewayapi.ChatInputStateFailed)
				row.Error = "The previous run stopped with an error. Remove or retry this message to continue."
				_, err = s.saveChatInput(ctx, row)
				return err
			}
			finished := false
			if assistant.Finish != nil {
				finished = *assistant.Finish != "tool-calls" && *assistant.Finish != "unknown"
			}
			if !row.Resume && assistant.Error == nil && !finished {
				return nil
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
		if row.Origin == gatewaydb.ChatInputOriginPulse {
			instruction := pulseInstruction
			body.System = &instruction
		}
		if row.Origin == gatewaydb.ChatInputOriginWorkflowResult {
			noReply := true
			body.NoReply = &noReply
		}
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
		if row.Origin != gatewaydb.ChatInputOriginUser {
			id := "prt_" + strings.ReplaceAll(row.ID.String(), "-", "") + "_" + file.Id
			text.Id = &id
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
	if row.Origin != gatewaydb.ChatInputOriginUser {
		saved, err := s.queries.GatewaySaveBackgroundPrompt(ctx, gatewaydb.GatewaySaveBackgroundPromptParams{
			ID:         row.ID,
			Background: raw,
		})
		if err != nil {
			return err
		}
		if saved != 1 {
			return errors.New("background input was canceled before admission")
		}
	}
	row.State = string(gatewayapi.ChatInputStateSending)
	row, err = s.saveChatInput(ctx, row)
	if err != nil {
		return err
	}
	if row.Origin == gatewaydb.ChatInputOriginWorkflowResult {
		response, err := client.SessionPromptWithBodyWithResponse(ctx, row.AgentName, row.SessionID,
			&gatewayapi.SessionPromptParams{Directory: &directory}, "application/json", bytes.NewReader(raw))
		if err != nil {
			return err
		}
		if response.StatusCode() != http.StatusOK {
			return fmt.Errorf("context insertion is uncertain: %s", response.Status())
		}
		_, err = s.reconcileChatInput(ctx, client, directory, row)
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
