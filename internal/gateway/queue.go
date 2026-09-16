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
	workspace, err := s.queries.GatewayGetWorkspace(ctx, gatewaydb.GatewayGetWorkspaceParams{
		ID: access.workspaceID, OrganizationID: access.organizationID,
	})
	if err != nil {
		return access, "", "", err
	}
	if workspace.Type == gatewaydb.WorkspaceTypeCoding {
		row, err := s.resolveCodingSession(ctx, access, agent, session)
		if err != nil {
			return access, "", "", err
		}
		if row.CodingProject.Deleting || row.CodingWorktree.Deleting || !row.CodingWorktree.Ready {
			return access, "", "", errors.New("checkout is unavailable")
		}
		return access, "/home/agentz/" + row.CodingWorktree.Directory, row.CodingProject.ID, nil
	}
	client, err := s.codingClient(ctx, access.namespace, agent, s.outboundHTTP)
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
	_, release, err := lockGatewayResource(ctx, s.controlDB, "session-admission/"+workspace+"/"+agent+"/"+session, false)
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
		Id: row.ID, Author: gatewayapi.ResourceActor{Id: row.AuthorID, Name: &row.AuthorName},
		Delivery: gatewayapi.ChatInputDelivery(row.Delivery), State: gatewayapi.ChatInputState(row.State),
		Revision: row.Revision, CreatedAt: row.CreatedAt, Error: row.Error,
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
		WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session, AuthorID: access.userID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result := gatewayapi.ChatInputs{Items: make([]gatewayapi.ChatInput, 0, len(rows))}
	result.Stopping, err = s.queries.GatewayChatInputsStopping(r.Context(), gatewaydb.GatewayChatInputsStoppingParams{
		WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session,
	})
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
		if path.IsAbs(file.Path) || path.Clean(file.Path) != file.Path || strings.HasPrefix(file.Path, "../") || file.Path == ".." {
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
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_input", err.Error(), err))
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
		ID: input.Id, WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session,
		OrganizationID: access.organizationID, AuthorID: access.userID,
		AuthorName: auth.actorName, Directory: directory, Content: raw, Delivery: string(input.Delivery),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "input_conflict", "This request ID belongs to another message.", err))
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
		ID: inputID, WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session,
	})
	if err != nil || row.AuthorID != access.userID {
		apiutil.WriteError(w, r, mapGatewayStoreError("get message", pgx.ErrNoRows))
		return
	}
	if row.Revision != input.Revision || row.State == "sending" || row.State == "delivered" || row.State == "removed" || row.MessageID != "" {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "input_changed", "This message changed or is already being sent.", nil))
		return
	}
	switch input.Action {
	case gatewayapi.ChatInputUpdateActionRetry:
		row.Resume = true
		row.State = "queued"
	case gatewayapi.ChatInputUpdateActionRemove:
		row.State = "removed"
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
	params := gatewaydb.GatewayStopChatInputsParams{WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session, Stopping: true}
	err = s.queries.GatewayStopChatInputs(r.Context(), params)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	client, err := s.codingClient(r.Context(), access.namespace, agent, s.outboundHTTP)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	rows, err := s.queries.GatewayListChatInputs(r.Context(), gatewaydb.GatewayListChatInputsParams{
		WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session, AuthorID: access.userID,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	deadline := time.Now().Add(10 * time.Second)
	settled := false
	stopped := false
	for time.Now().Before(deadline) {
		admitted := true
		for _, row := range rows {
			if row.MessageID == "" {
				continue
			}
			message, err := client.SessionMessageWithResponse(r.Context(), agent, session, row.MessageID, &gatewayapi.SessionMessageParams{Directory: &directory})
			if err != nil || message.JSON200 == nil {
				admitted = false
				break
			}
		}
		if interrupt {
			response, err := client.V2SessionInterruptWithResponse(r.Context(), agent, session)
			if err != nil || response.StatusCode() != http.StatusNoContent {
				break
			}
		} else {
			response, err := client.SessionAbortWithResponse(r.Context(), agent, session, &gatewayapi.SessionAbortParams{Directory: &directory})
			if err != nil || response.JSON200 == nil || !*response.JSON200 {
				break
			}
		}
		status, err := client.SessionStatusWithResponse(r.Context(), agent, &gatewayapi.SessionStatusParams{Directory: &directory})
		if err != nil || status.JSON200 == nil {
			break
		}
		idle := true
		if value, ok := (*status.JSON200)[session]; ok {
			state, err := value.Discriminator()
			idle = err == nil && state == string(gatewayapi.Idle)
		}
		active, err := s.queries.GatewayResourceBusy(r.Context(), "session-execution/"+access.workspaceID+"/"+agent+"/"+session)
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
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "stop_failed", "Could not confirm the agent stopped. Queued messages are held; retry Stop.", nil))
		return
	}
	for _, row := range rows {
		if row.MessageID == "" {
			continue
		}
		row.State = "delivered"
		if _, err := s.saveChatInput(r.Context(), row); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	err = s.queries.GatewayRecoverChatInputs(r.Context(), gatewaydb.GatewayRecoverChatInputsParams{
		WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session,
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
	if err := s.refreshOpenCodeStatus(r.Context(), target, access.workspaceID, agent); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	s.notifyChatInput(r.Context(), gatewaydb.ChatInput{WorkspaceID: access.workspaceID, AgentName: agent, SessionID: session})
	if interrupt {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, true)
}

func (s *Service) notifyChatInput(ctx context.Context, row gatewaydb.ChatInput) {
	err := s.queries.GatewayNotifyChatInputs(ctx, gatewaydb.GatewayNotifyChatInputsParams{
		WorkspaceID: row.WorkspaceID, AgentName: row.AgentName, SessionID: pgtype.Text{String: row.SessionID, Valid: true},
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
		ID: row.ID, Revision: row.Revision, State: row.State, Error: row.Error, MessageID: row.MessageID, Resume: row.Resume,
	})
	if err == nil {
		s.notifyChatInput(ctx, saved)
	}
	return saved, err
}

func (s *Service) runChatInputs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.chatInputWake:
		case <-ticker.C:
		}
		rows, err := s.queries.GatewayPendingChatInputs(ctx)
		if err != nil {
			slog.ErrorContext(ctx, "read pending chat inputs", "error", err)
			continue
		}
		var wg sync.WaitGroup
		slots := make(chan struct{}, 4)
		for _, row := range rows {
			if row.State == "failed" && row.MessageID == "" {
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
				if err := s.deliverChatInput(ctx, row); err != nil && ctx.Err() == nil {
					slog.ErrorContext(ctx, "deliver chat input", "input", row.ID, "error", err)
				}
			})
		}
		wg.Wait()
	}
}

func (s *Service) deliverChatInput(ctx context.Context, row gatewaydb.ChatInput) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	claims := gatewayClaims{UserID: row.AuthorID, OrganizationID: row.OrganizationID, WorkspaceID: row.WorkspaceID}
	ctx = context.WithValue(ctx, authContextKey{}, requestAuth{
		claims: &claims, userID: row.AuthorID, userName: row.AuthorName, actorID: row.AuthorID, actorName: row.AuthorName, actorType: requestActorUser,
		workspaceID: row.WorkspaceID, organizationID: row.OrganizationID,
	})
	access, directory, project, err := s.chatInputAccess(ctx, row.AgentName, row.SessionID)
	if err != nil {
		var denied *apiutil.APIError
		if errors.Is(err, pgx.ErrNoRows) || errors.As(err, &denied) && denied.Status == http.StatusForbidden {
			release, lockErr := s.lockChatInputs(ctx, row.WorkspaceID, row.AgentName, row.SessionID, "")
			if lockErr != nil {
				return lockErr
			}
			defer release()
			row.State, row.Error = "failed", "The author no longer has access to this conversation or its agent. Restore access before retrying."
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
		ID: row.ID, WorkspaceID: row.WorkspaceID, AgentName: row.AgentName, SessionID: row.SessionID,
	})
	if err != nil {
		return err
	}
	if row.State != "queued" && row.State != "sending" && (row.State != "failed" || row.MessageID == "") {
		return nil
	}
	stopping, err := s.queries.GatewayChatInputsStopping(ctx, gatewaydb.GatewayChatInputsStoppingParams{
		WorkspaceID: row.WorkspaceID, AgentName: row.AgentName, SessionID: row.SessionID,
	})
	if err != nil {
		return err
	}
	if stopping && row.MessageID == "" {
		return nil
	}
	client, err := s.codingClient(ctx, access.namespace, row.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	if row.MessageID != "" {
		response, err := client.SessionMessageWithResponse(ctx, row.AgentName, row.SessionID, row.MessageID, &gatewayapi.SessionMessageParams{Directory: &directory})
		if err != nil {
			return err
		}
		if response.JSON200 != nil {
			row.State = "delivered"
			_, err = s.saveChatInput(ctx, row)
			return err
		}
		if row.State == "failed" || time.Since(row.UpdatedAt) < time.Minute {
			return nil
		}
		row.State, row.Error = "failed", "Delivery could not be confirmed. Reload the conversation before sending this message again."
		_, err = s.saveChatInput(ctx, row)
		return err
	}
	head, err := s.queries.GatewayHeadChatInput(ctx, gatewaydb.GatewayHeadChatInputParams{
		WorkspaceID: row.WorkspaceID, AgentName: row.AgentName, SessionID: row.SessionID,
	})
	if err != nil {
		return err
	}
	if head.ID != row.ID {
		return nil
	}
	// A queued follow-up must never be injected into an unfinished turn. Read
	// history as well as status: prompt_async can acknowledge before busy appears.
	status, err := client.SessionStatusWithResponse(ctx, row.AgentName, &gatewayapi.SessionStatusParams{Directory: &directory})
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
	permissions, err := client.PermissionListWithResponse(ctx, row.AgentName, &gatewayapi.PermissionListParams{Directory: &directory})
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
	questions, err := client.QuestionListWithResponse(ctx, row.AgentName, &gatewayapi.QuestionListParams{Directory: &directory})
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
	if row.Delivery == "queue" {
		if busy {
			return nil
		}
		limit := 200
		history, err := client.SessionMessagesWithResponse(ctx, row.AgentName, row.SessionID, &gatewayapi.SessionMessagesParams{Directory: &directory, Limit: &limit})
		if err != nil {
			return err
		}
		if history.JSON200 == nil {
			return errors.New("could not verify the previous turn")
		}
		var user gatewayapi.OpencodeUserMessage
		var assistant gatewayapi.OpencodeAssistantMessage
		for _, message := range *history.JSON200 {
			// These generated views expose the protocol's role discriminator.
			candidate, err := message.Info.AsOpencodeUserMessage()
			if err != nil {
				return err
			}
			if candidate.Role == gatewayapi.OpencodeUserMessageRoleUser {
				user = candidate
				continue
			}
			assistant, err = message.Info.AsOpencodeAssistantMessage()
			if err != nil {
				return err
			}
		}
		if user.Id != "" {
			if assistant.ParentID != user.Id || assistant.Time.Completed == nil {
				return nil
			}
			if assistant.Error != nil && !row.Resume {
				row.State, row.Error = "failed", "The previous run stopped with an error. Remove or retry this message to continue."
				_, err = s.saveChatInput(ctx, row)
				return err
			}
			if !row.Resume && assistant.Error == nil && (assistant.Finish == nil || *assistant.Finish == "tool-calls" || *assistant.Finish == "unknown") {
				return nil
			}
		}
	}
	var content gatewayapi.ChatInputContent
	if err := json.Unmarshal(row.Content, &content); err != nil {
		return err
	}
	body := gatewayapi.SessionPromptAsyncJSONRequestBody{
		Agent: content.Agent, Model: &content.Model, Variant: content.Variant,
		Parts: make([]gatewayapi.OpencodePromptPartInput, 0, len(content.Attachments)+1),
	}
	for _, file := range content.Attachments {
		filePath, _ := json.Marshal("/home/agentz/" + file.Path)
		filename, _ := json.Marshal(file.Filename)
		mime, _ := json.Marshal(file.MediaType)
		synthetic := true
		text := gatewayapi.OpencodeTextPartInput{
			Type: gatewayapi.OpencodeTextPartInputTypeText, Synthetic: &synthetic,
			Metadata: &map[string]any{"agentz_attachment": file},
			Text:     fmt.Sprintf("<attached_file>\npath: %s\nname: %s\nmedia_type: %s\nsize: %d bytes\nThe path is exact. Copy it verbatim; do not shorten or remove directories.\nUse analyze_file when you need the contents of this file.\n</attached_file>", filePath, filename, mime, file.Size),
		}
		var part gatewayapi.OpencodePromptPartInput
		if err := part.FromOpencodeTextPartInput(text); err != nil {
			return err
		}
		body.Parts = append(body.Parts, part)
	}
	var part gatewayapi.OpencodePromptPartInput
	text := gatewayapi.OpencodeTextPartInput{Type: gatewayapi.OpencodeTextPartInputTypeText, Text: strings.TrimSpace(content.Text)}
	if err := part.FromOpencodeTextPartInput(text); err != nil {
		return err
	}
	body.Parts = append(body.Parts, part)
	// Match OpenCode's ascending timestamp prefix, but allocate at admission,
	// since a follow-up may have waited while later steers were submitted.
	row.MessageID = fmt.Sprintf("msg_%012x%s", (time.Now().UnixMilli()<<12)&0xffffffffffff, rand.Text()[:14])
	body.MessageID = &row.MessageID
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://agent", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	auth, _ := requestAuthState(ctx)
	route := &opencodeRouteMatch{Method: http.MethodPost, ID: "session.prompt_async", Params: map[string]string{"sessionID": row.SessionID}}
	if err := attributeOpenCodePrompt(req, route, auth); err != nil {
		return err
	}
	row.State = "sending"
	row, err = s.saveChatInput(ctx, row)
	if err != nil {
		return err
	}
	response, err := client.SessionPromptAsyncWithBodyWithResponse(ctx, row.AgentName, row.SessionID,
		&gatewayapi.SessionPromptAsyncParams{Directory: &directory}, "application/json", req.Body)
	if err != nil {
		return err
	} // Keep uncertain admission for reconciliation.
	if response.StatusCode() >= 500 || response.StatusCode() < 400 && response.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("agent admission is uncertain: %s", response.Status())
	}
	if response.StatusCode() != http.StatusNoContent {
		row.State, row.Error, row.MessageID = "failed", fmt.Sprintf("The agent rejected this message (%d). Remove or retry it.", response.StatusCode()), ""
		_, err = s.saveChatInput(ctx, row)
		return err
	}
	return s.recordOpenCodePrompt(ctx, route, auth, row.WorkspaceID, row.AgentName)
}
