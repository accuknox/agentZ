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
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/tmaxmax/go-sse"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func chatExecutionView(execution gatewaydb.ChatExecution) gatewayapi.ConversationExecution {
	return gatewayapi.ConversationExecution{
		Id:            execution.ID,
		State:         gatewayapi.ConversationExecutionState(execution.State),
		Attempt:       int(execution.Attempt),
		Continuations: int(execution.Continuations),
		Reason:        execution.Reason,
		Message:       execution.Message,
		CreatedAt:     execution.CreatedAt,
		UpdatedAt:     execution.UpdatedAt,
	}
}

// GetChatExecution reads tracked work without importing native history.
func (s *Service) GetChatExecution(w http.ResponseWriter, r *http.Request, agent string, session string) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	_, _, _, err := s.chatInputAccess(r.Context(), agent, session)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("read execution", err))
		return
	}
	execution, err := s.queries.GatewaySessionChatExecution(r.Context(), gatewaydb.GatewaySessionChatExecutionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	result := gatewayapi.ChatExecutionResponse{}
	if err == nil {
		result.Execution = new(chatExecutionView(execution))
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// recordChatPrompt commits native admission intent before engine I/O. Callers
// hold the session admission lock, so steering joins one logical execution.
func (s *Service) recordChatPrompt(ctx context.Context, input gatewaydb.GatewayCreateChatExecutionParams, payload []byte, messageID string) (gatewaydb.ChatExecution, error) {
	resolved, incarnation, err := s.resolver.agentRuntime(ctx, input.Namespace, input.AgentName)
	if err != nil {
		return gatewaydb.ChatExecution{}, err
	}
	input.AgentUid = string(resolved.Agent.UID)
	err = s.watchChatRuntime(ctx, input.Namespace, input.WorkspaceID, input.AgentName, incarnation)
	if err != nil {
		return gatewaydb.ChatExecution{}, err
	}
	previous, err := s.queries.GatewaySessionChatExecution(ctx, gatewaydb.GatewaySessionChatExecutionParams{
		WorkspaceID: input.WorkspaceID,
		AgentName:   input.AgentName,
		SessionID:   input.SessionID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return gatewaydb.ChatExecution{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return gatewaydb.ChatExecution{}, err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	execution := previous
	active := previous.ID != uuid.Nil &&
		previous.State != gatewaydb.ChatExecutionStateCompleted &&
		previous.State != gatewaydb.ChatExecutionStateCancelled &&
		previous.State != gatewaydb.ChatExecutionStateFailed
	if active && previous.Protocol != input.Protocol {
		return gatewaydb.ChatExecution{}, errors.New("conversation is executing through another native protocol")
	}
	if active && previous.WorkflowRunUid != input.WorkflowRunUid {
		return gatewaydb.ChatExecution{}, errors.New("conversation is executing another request")
	}
	awaitingRecovery := previous.State == gatewaydb.ChatExecutionStateRecovering ||
		previous.State == gatewaydb.ChatExecutionStateBlocked
	if active && awaitingRecovery && messageID != "" {
		_, err = q.GatewayCancelChatExecution(ctx, gatewaydb.GatewayCancelChatExecutionParams{
			WorkspaceID: input.WorkspaceID,
			AgentName:   input.AgentName,
			SessionID:   input.SessionID,
			Reason:      "newer_input",
			Message:     "New input superseded automatic recovery",
		})
		if err != nil {
			return execution, err
		}
		err = q.GatewayFinishChatAttempts(ctx, gatewaydb.GatewayFinishChatAttemptsParams{
			WorkspaceID: input.WorkspaceID,
			AgentName:   input.AgentName,
			SessionID:   input.SessionID,
		})
		if err != nil {
			return execution, err
		}
		active = false
	}
	if !active {
		if input.ID == uuid.Nil {
			input.ID = uuid.New()
		}
		execution, err = q.GatewayCreateChatExecution(ctx, input)
		if err != nil {
			return execution, err
		}
		err = q.GatewayCreateChatAttempt(ctx, gatewaydb.GatewayCreateChatAttemptParams{
			ExecutionID: execution.ID,
			Number:      1,
			Incarnation: incarnation,
			Payload:     payload,
			MessageID:   messageID,
		})
		if err != nil {
			return execution, err
		}
	}
	if messageID != "" {
		err = q.GatewayCreateChatExecutionPrompt(ctx, gatewaydb.GatewayCreateChatExecutionPromptParams{
			ExecutionID: execution.ID,
			Attempt:     execution.Attempt,
			MessageID:   messageID,
		})
		if err != nil {
			return execution, err
		}
		if active {
			err = q.GatewayAdmitChatAttempt(ctx, gatewaydb.GatewayAdmitChatAttemptParams{
				ExecutionID: execution.ID,
				Number:      execution.Attempt,
				MessageID:   messageID,
				Payload:     payload,
			})
			if err != nil {
				return execution, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return execution, err
	}
	err = s.queries.GatewayNotifyChatInputs(ctx, gatewaydb.GatewayNotifyChatInputsParams{
		WorkspaceID: execution.WorkspaceID,
		AgentName:   execution.AgentName,
		SessionID:   pgtype.Text{String: execution.SessionID, Valid: true},
	})
	return execution, err
}

func (s *Service) runChatExecutions(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		seen := make(map[uuid.UUID]struct{})
		for {
			rows, err := s.queries.GatewayPendingChatExecutions(ctx)
			if err != nil {
				if ctx.Err() == nil {
					slog.ErrorContext(ctx, "read conversation executions", "error", err)
				}
				break
			}
			var workers sync.WaitGroup
			slots := make(chan struct{}, 4)
			pending := false
			for _, execution := range rows {
				if _, visited := seen[execution.ID]; visited {
					continue
				}
				seen[execution.ID] = struct{}{}
				pending = true
				select {
				case slots <- struct{}{}:
				case <-ctx.Done():
					workers.Wait()
					return
				}
				workers.Go(func() {
					defer func() { <-slots }()
					err := s.reconcileChatExecution(ctx, execution)
					if err != nil && ctx.Err() == nil {
						slog.ErrorContext(ctx, "reconcile conversation execution", "execution", execution.ID, "error", err)
					}
				})
			}
			workers.Wait()
			// Released leases move to the back of the queue. Drain unseen work before waiting.
			if !pending || len(rows) < 100 {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-s.resolver.runtimeWake:
		case <-ticker.C:
		}
	}
}

func (s *Service) reconcileChatExecution(ctx context.Context, execution gatewaydb.ChatExecution) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	auth := requestAuth{
		actorID:         execution.ActorID,
		actorName:       execution.ActorName,
		actorType:       requestActorType(execution.ActorType),
		userID:          execution.UserID,
		userName:        execution.ActorName,
		workspaceID:     execution.WorkspaceID,
		organizationID:  execution.OrganizationID,
		tenantNamespace: execution.Namespace,
	}
	if execution.UserID != "" {
		auth.claims = &gatewayClaims{
			UserID:         execution.UserID,
			OrganizationID: execution.OrganizationID,
			WorkspaceID:    execution.WorkspaceID,
		}
	}
	ctx = context.WithValue(ctx, authContextKey{}, auth)
	_, directory, project, accessErr := s.chatInputAccess(ctx, execution.AgentName, execution.SessionID)
	if execution.ActorType == string(requestActorAPIKey) && accessErr == nil {
		valid, err := s.queries.GatewayChatExecutionAPIKeyValid(ctx, gatewaydb.GatewayChatExecutionAPIKeyValidParams{
			ApiKeyID:       execution.ActorID,
			OrganizationID: execution.OrganizationID,
			WorkspaceID:    execution.WorkspaceID,
			UserID:         execution.UserID,
			AgentName:      execution.AgentName,
		})
		if err != nil {
			return err
		}
		if !valid {
			accessErr = resourceForbidden(errors.New("execution API key no longer has access"))
		}
	}
	if accessErr != nil {
		var denied *apiutil.APIError
		inaccessible := errors.Is(accessErr, pgx.ErrNoRows) ||
			errors.As(accessErr, &denied) && denied.Status == http.StatusForbidden
		if !inaccessible {
			return accessErr
		}
		directory = execution.Directory
	}
	unlock, err := s.lockChatInputs(ctx, execution.WorkspaceID, execution.AgentName, execution.SessionID, project)
	if err != nil {
		return err
	}
	defer unlock()
	execution, err = s.queries.GatewayClaimChatExecution(ctx, gatewaydb.GatewayClaimChatExecutionParams{
		ID:         execution.ID,
		Attempt:    execution.Attempt,
		LeaseToken: rand.Text(),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		err := s.queries.GatewayReleaseChatExecution(cleanup, gatewaydb.GatewayReleaseChatExecutionParams{
			ID:         execution.ID,
			LeaseToken: execution.LeaseToken,
		})
		if err != nil {
			slog.ErrorContext(cleanup, "release conversation execution", "execution", execution.ID, "error", err)
		}
	}()
	update := gatewaydb.GatewayUpdateChatExecutionParams{
		ID:            execution.ID,
		WorkspaceID:   execution.WorkspaceID,
		Attempt:       execution.Attempt,
		LeaseToken:    execution.LeaseToken,
		State:         execution.State,
		Reason:        execution.Reason,
		Message:       execution.Message,
		WaitingOnUser: execution.WaitingOnUser,
	}
	if accessErr != nil {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "access_changed"
		update.Message = "The execution's author or checkout is no longer accessible"
		return s.updateChatExecution(ctx, update)
	}
	resolved, incarnation, err := s.resolver.agentRuntime(ctx, execution.Namespace, execution.AgentName)
	if errors.Is(err, errAgentNotFound) {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "agent_deleted"
		update.Message = "The original agent no longer exists"
		return s.updateChatExecution(ctx, update)
	}
	if err != nil {
		return err
	}
	err = s.watchChatRuntime(ctx, execution.Namespace, execution.WorkspaceID, execution.AgentName, incarnation)
	if err != nil {
		return err
	}
	if string(resolved.Agent.UID) != execution.AgentUid {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "agent_replaced"
		update.Message = "The original agent no longer exists"
		return s.updateChatExecution(ctx, update)
	}
	if directory != execution.Directory {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "directory_changed"
		update.Message = "The conversation checkout changed"
		return s.updateChatExecution(ctx, update)
	}
	if execution.WorkflowRunUid != "" {
		run := &agentzv1alpha1.WorkflowRun{}
		err = s.k8sClient.Get(ctx, ctrlclient.ObjectKey{
			Namespace: execution.Namespace,
			Name:      execution.WorkflowRunName,
		}, run)
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		workflowEnded := apierrors.IsNotFound(err) ||
			string(run.UID) != execution.WorkflowRunUid ||
			run.Status.SessionID != execution.SessionID ||
			run.Status.ExecutionID != execution.ID.String() ||
			run.Spec.AgentName != execution.AgentName ||
			run.Spec.WorkflowName != execution.WorkflowName ||
			!run.DeletionTimestamp.IsZero() ||
			run.Status.Phase != agentzv1alpha1.WorkflowRunPhaseRunning
		if workflowEnded {
			update.State = gatewaydb.ChatExecutionStateCancelled
			update.Reason = "workflow_ended"
			update.Message = "The workflow run ended"
			return s.updateChatExecution(ctx, update)
		}
	}
	if execution.Deadline.Valid && !time.Now().Before(execution.Deadline.Time) {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "timed_out"
		update.Message = "The original workflow deadline expired"
		return s.updateChatExecution(ctx, update)
	}
	client, err := s.agentClient(ctx, execution.Namespace, execution.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	attempt, err := s.queries.GatewayGetChatAttempt(ctx, gatewaydb.GatewayGetChatAttemptParams{
		ExecutionID: execution.ID,
		Number:      execution.Attempt,
	})
	if err != nil {
		return err
	}
	if attempt.State == gatewaydb.ChatAttemptStatePending && attempt.Incarnation == incarnation {
		return s.submitChatAttempt(ctx, client, execution, attempt)
	}
	return s.observeChatAttempt(ctx, client, execution, attempt, incarnation, update)
}

type chatAttemptObservation struct {
	busy, completed, failed, aborted, waiting, missing bool
}

func (s *Service) observeChatAttempt(ctx context.Context, client *gatewayapi.ClientWithResponses, execution gatewaydb.ChatExecution, attempt gatewaydb.GatewayGetChatAttemptRow, incarnation string, update gatewaydb.GatewayUpdateChatExecutionParams) error {
	prompts, err := s.queries.GatewayChatExecutionPrompts(ctx, gatewaydb.GatewayChatExecutionPromptsParams{
		ExecutionID: execution.ID,
		Attempt:     execution.Attempt,
	})
	if err != nil {
		return err
	}
	changed := incarnation != attempt.Incarnation
	var observed chatAttemptObservation
	switch execution.Protocol {
	case gatewaydb.ChatProtocolV1:
		observed, err = s.readChatAttempt(ctx, client, execution, prompts, changed)
	case gatewaydb.ChatProtocolV2:
		observed, err = s.readV2ChatAttempt(ctx, client, execution, prompts, changed)
	}
	if err != nil {
		return err
	}
	accepted := len(prompts) > 0 && prompts[len(prompts)-1].Accepted
	switch {
	case observed.missing:
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "native_session_missing"
		update.Message = "The saved native conversation is unavailable"
	case observed.completed && !observed.failed:
		update.State = gatewaydb.ChatExecutionStateCompleted
		update.Reason = "completed"
		update.Message = "Conversation execution completed"
	case observed.waiting || execution.WaitingOnUser && changed:
		update.State = gatewaydb.ChatExecutionStateBlocked
		update.Reason = "waiting_on_user"
		update.Message = "The interrupted conversation needs your response"
		update.WaitingOnUser = true
	case observed.busy && !changed:
		update.State = gatewaydb.ChatExecutionStateRunning
		update.Reason = "running"
		update.Message = "Conversation execution is running"
		update.WaitingOnUser = false
	case observed.completed && observed.failed && (!observed.aborted || !changed):
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "native_execution_failed"
		update.Message = "The agent stopped with an error"
	case changed:
		return s.continueChatExecution(ctx, execution, attempt, incarnation, accepted, update)
	case !observed.busy && time.Since(attempt.UpdatedAt) >= time.Minute:
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "admission_unconfirmed"
		update.Message = "The agent did not confirm a running or completed execution"
	default:
		return nil
	}
	return s.updateChatExecution(ctx, update)
}

func (s *Service) readChatAttempt(ctx context.Context, client *gatewayapi.ClientWithResponses, execution gatewaydb.ChatExecution, prompts []gatewaydb.ChatExecutionPrompt, runtimeChanged bool) (chatAttemptObservation, error) {
	status, err := client.SessionStatusWithResponse(ctx, execution.AgentName, &gatewayapi.SessionStatusParams{Directory: &execution.Directory})
	if err != nil {
		return chatAttemptObservation{}, err
	}
	if status.JSON200 == nil {
		return chatAttemptObservation{}, fmt.Errorf("read native execution status: %s", status.Status())
	}
	busy := false
	if value, ok := (*status.JSON200)[execution.SessionID]; ok {
		kind, err := value.Discriminator()
		if err != nil {
			return chatAttemptObservation{}, err
		}
		busy = kind != string(gatewayapi.Idle)
	}
	permissions, err := client.PermissionListWithResponse(
		ctx,
		execution.AgentName,
		&gatewayapi.PermissionListParams{Directory: &execution.Directory},
	)
	if err != nil {
		return chatAttemptObservation{}, err
	}
	questions, err := client.QuestionListWithResponse(
		ctx,
		execution.AgentName,
		&gatewayapi.QuestionListParams{Directory: &execution.Directory},
	)
	if err != nil {
		return chatAttemptObservation{}, err
	}
	if permissions.JSON200 == nil || questions.JSON200 == nil {
		return chatAttemptObservation{}, errors.New("could not verify pending user input")
	}
	waiting := slices.ContainsFunc(*permissions.JSON200, func(request gatewayapi.OpencodePermissionRequest) bool {
		return request.SessionID == execution.SessionID
	})
	if !waiting {
		waiting = slices.ContainsFunc(*questions.JSON200, func(request gatewayapi.OpencodeQuestionRequest) bool {
			return request.SessionID == execution.SessionID
		})
	}
	// Once admission is confirmed, busy turns need history only after a restart.
	confirmed := len(prompts) > 0 && prompts[len(prompts)-1].Accepted
	if busy && !runtimeChanged && confirmed {
		return chatAttemptObservation{busy: busy, waiting: waiting}, nil
	}

	history, err := client.SessionMessagesWithResponse(ctx, execution.AgentName, execution.SessionID, &gatewayapi.SessionMessagesParams{
		Directory: &execution.Directory,
		Limit:     new(200),
	})
	if err != nil {
		return chatAttemptObservation{}, err
	}
	if history.StatusCode() == http.StatusNotFound {
		return chatAttemptObservation{missing: true}, nil
	}
	if history.JSON200 == nil {
		return chatAttemptObservation{}, fmt.Errorf("read native conversation: %s", history.Status())
	}
	var lastUser string
	var assistant gatewayapi.OpencodeAssistantMessage
	for _, message := range *history.JSON200 {
		role, err := message.Info.Discriminator()
		if err != nil {
			return chatAttemptObservation{}, err
		}
		switch role {
		case "user":
			user, err := message.Info.AsOpencodeUserMessage()
			if err != nil {
				return chatAttemptObservation{}, err
			}
			lastUser = user.Id
			for i := range prompts {
				if prompts[i].MessageID == user.Id && !prompts[i].Accepted {
					prompts[i].Accepted = true
					err = s.queries.GatewayAcceptChatExecutionPrompt(ctx, gatewaydb.GatewayAcceptChatExecutionPromptParams{
						ExecutionID: execution.ID,
						MessageID:   user.Id,
					})
					if err != nil {
						return chatAttemptObservation{}, err
					}
				}
			}
		case "assistant":
			assistant, err = message.Info.AsOpencodeAssistantMessage()
			if err != nil {
				return chatAttemptObservation{}, err
			}
		}
	}
	accepted := len(prompts) > 0 && prompts[len(prompts)-1].Accepted
	tracked := assistant.ParentID == lastUser && lastUser != ""
	if !tracked {
		tracked = slices.ContainsFunc(prompts, func(prompt gatewaydb.ChatExecutionPrompt) bool {
			return prompt.MessageID == assistant.ParentID
		})
	}
	finished := assistant.Finish != nil && *assistant.Finish != "tool-calls" && *assistant.Finish != "unknown"
	completed := accepted && tracked && !busy && assistant.Time.Completed != nil && (finished || assistant.Error != nil)
	aborted := false
	if assistant.Error != nil {
		kind, err := assistant.Error.Discriminator()
		if err != nil {
			return chatAttemptObservation{}, err
		}
		aborted = kind == "MessageAbortedError"
	}
	return chatAttemptObservation{
		busy:      busy,
		completed: completed,
		failed:    assistant.Error != nil,
		aborted:   aborted,
		waiting:   waiting,
	}, nil
}

func (s *Service) readV2ChatAttempt(ctx context.Context, client *gatewayapi.ClientWithResponses, execution gatewaydb.ChatExecution, prompts []gatewaydb.ChatExecutionPrompt, runtimeChanged bool) (chatAttemptObservation, error) {
	active, err := client.V2SessionActiveWithResponse(ctx, execution.AgentName)
	if err != nil {
		return chatAttemptObservation{}, err
	}
	if active.JSON200 == nil {
		return chatAttemptObservation{}, fmt.Errorf("read native active sessions: %s", active.Status())
	}
	_, busy := active.JSON200.Data[execution.SessionID]
	confirmed := len(prompts) > 0 && prompts[len(prompts)-1].Accepted
	if busy && !runtimeChanged && confirmed {
		return chatAttemptObservation{busy: true, waiting: execution.WaitingOnUser}, nil
	}
	history, err := client.V2SessionMessagesWithResponse(ctx, execution.AgentName, execution.SessionID, &gatewayapi.V2SessionMessagesParams{
		Order: new(gatewayapi.V2SessionMessagesParamsOrderDesc),
		Limit: new(float32(200)),
	})
	if err != nil {
		return chatAttemptObservation{}, err
	}
	if history.StatusCode() == http.StatusNotFound {
		return chatAttemptObservation{missing: true}, nil
	}
	if history.JSON200 == nil {
		return chatAttemptObservation{}, fmt.Errorf("read native session messages: %s", history.Status())
	}
	var assistant gatewayapi.OpencodeSessionMessageAssistant
	var user gatewayapi.OpencodeSessionMessageUser
	assistantIndex, userIndex := -1, -1
	for index, message := range history.JSON200.Data {
		kind, err := message.Discriminator()
		if err != nil {
			return chatAttemptObservation{}, err
		}
		switch kind {
		case string(gatewayapi.OpencodeSessionMessageUserTypeUser):
			current, err := message.AsOpencodeSessionMessageUser()
			if err != nil {
				return chatAttemptObservation{}, err
			}
			if user.Id == "" {
				user = current
				userIndex = index
			}
			for i := range prompts {
				if prompts[i].MessageID != current.Id || prompts[i].Accepted {
					continue
				}
				prompts[i].Accepted = true
				err = s.queries.GatewayAcceptChatExecutionPrompt(ctx, gatewaydb.GatewayAcceptChatExecutionPromptParams{
					ExecutionID: execution.ID,
					MessageID:   current.Id,
				})
				if err != nil {
					return chatAttemptObservation{}, err
				}
			}
		case string(gatewayapi.OpencodeSessionMessageAssistantTypeAssistant):
			if assistant.Id != "" {
				continue
			}
			assistantIndex = index
			assistant, err = message.AsOpencodeSessionMessageAssistant()
			if err != nil {
				return chatAttemptObservation{}, err
			}
		}
	}
	accepted := len(prompts) > 0 && prompts[len(prompts)-1].Accepted
	tracked := slices.ContainsFunc(prompts, func(prompt gatewaydb.ChatExecutionPrompt) bool { return prompt.MessageID == user.Id })
	finished := assistant.Finish != nil && *assistant.Finish != "tool-calls" && *assistant.Finish != "unknown"
	completed := accepted && tracked && !busy && finished &&
		assistant.Time.Completed != nil && assistantIndex >= 0 && assistantIndex < userIndex
	return chatAttemptObservation{
		busy:      busy,
		completed: completed,
		failed:    assistant.Error != nil,
		waiting:   execution.WaitingOnUser,
	}, nil
}

func (s *Service) continueChatExecution(ctx context.Context, execution gatewaydb.ChatExecution, attempt gatewaydb.GatewayGetChatAttemptRow, incarnation string, accepted bool, update gatewaydb.GatewayUpdateChatExecutionParams) error {
	if !s.cfg.ConversationRecoveryEnabled {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "recovery_disabled"
		update.Message = "Automatic conversation recovery is disabled"
		return s.updateChatExecution(ctx, update)
	}
	if execution.Continuations == 3 {
		update.State = gatewaydb.ChatExecutionStateFailed
		update.Reason = "restart_limit_reached"
		update.Message = "The conversation stopped after three consecutive restart continuations"
		return s.updateChatExecution(ctx, update)
	}
	payload, err := s.queries.GatewayChatAttemptPayload(ctx, gatewaydb.GatewayChatAttemptPayloadParams{
		ExecutionID: attempt.ExecutionID,
		Number:      attempt.Number,
	})
	if err != nil {
		return err
	}
	originalPayload := payload
	if accepted || execution.Continuations > 0 {
		var data workflowRunPromptData
		if execution.WorkflowRunUid != "" {
			run := &agentzv1alpha1.WorkflowRun{}
			err := s.k8sClient.Get(ctx, types.NamespacedName{
				Namespace: execution.Namespace,
				Name:      execution.WorkflowRunName,
			}, run)
			if err != nil {
				return err
			}
			progress, err := json.Marshal(run.Status.Nodes)
			if err != nil {
				return err
			}
			data = workflowRunPromptData{
				AgentName:    execution.AgentName,
				WorkflowName: execution.WorkflowName,
				RunName:      execution.WorkflowRunName,
				ProgressJSON: string(progress),
			}
		}
		var prompt strings.Builder
		err := gatewayPrompts.ExecuteTemplate(&prompt, "conversation-recovery", data)
		if err != nil {
			return err
		}
		switch execution.Protocol {
		case gatewaydb.ChatProtocolV1:
			var body gatewayapi.SessionPromptAsyncJSONRequestBody
			if err := json.Unmarshal(payload, &body); err != nil {
				return err
			}
			metadata := map[string]any{"agentz.dev/restart-continuation": execution.ID.String()}
			if execution.ActorID != "" {
				actor := opencodeMessageActor{
					Version: 1,
					Type:    requestActorType(execution.ActorType),
					ID:      execution.ActorID,
					Name:    execution.ActorName,
				}
				if execution.UserID != "" {
					actor.Type = requestActorUser
					actor.ID = execution.UserID
				}
				metadata[opencodeActorMetadataKey] = actor
			}
			var part gatewayapi.OpencodePromptPartInput
			err := part.FromOpencodeTextPartInput(gatewayapi.OpencodeTextPartInput{
				Type:      gatewayapi.OpencodeTextPartInputTypeText,
				Text:      prompt.String(),
				Synthetic: new(true),
				Metadata:  &metadata,
			})
			if err != nil {
				return err
			}
			body.Parts = []gatewayapi.OpencodePromptPartInput{part}
			body.MessageID = nil
			payload, err = json.Marshal(body)
			if err != nil {
				return err
			}
		case gatewaydb.ChatProtocolV2:
			var body gatewayapi.V2SessionPromptJSONRequestBody
			if err := json.Unmarshal(payload, &body); err != nil {
				return err
			}
			body.Prompt = gatewayapi.OpencodePromptInput{Text: prompt.String()}
			body.Id = nil
			body.Resume = new(true)
			body.Delivery = new(gatewayapi.V2SessionPromptJSONBodyDeliveryQueue)
			var err error
			payload, err = json.Marshal(body)
			if err != nil {
				return err
			}
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	execution, err = q.GatewayContinueChatExecution(ctx, gatewaydb.GatewayContinueChatExecutionParams{
		ID:         execution.ID,
		Attempt:    execution.Attempt,
		LeaseToken: execution.LeaseToken,
	})
	if err != nil {
		return err
	}
	err = q.GatewayUpdateChatAttempt(ctx, gatewaydb.GatewayUpdateChatAttemptParams{
		ExecutionID:   attempt.ExecutionID,
		Number:        attempt.Number,
		State:         gatewaydb.ChatAttemptStateInterrupted,
		MessageID:     attempt.MessageID,
		Payload:       originalPayload,
		Submissions:   attempt.Submissions,
		NextAttemptAt: attempt.NextAttemptAt,
	})
	if err != nil {
		return err
	}
	err = q.GatewayCreateChatAttempt(ctx, gatewaydb.GatewayCreateChatAttemptParams{
		ExecutionID: execution.ID,
		Number:      execution.Attempt,
		Incarnation: incarnation,
		Payload:     payload,
	})
	if err != nil {
		return err
	}
	err = tx.Commit(ctx)
	if err == nil {
		slog.InfoContext(
			ctx,
			"conversation recovery scheduled",
			"execution", execution.ID,
			"attempt", execution.Attempt,
			"incarnation", incarnation,
		)
	}
	return err
}

func (s *Service) submitChatAttempt(ctx context.Context, client *gatewayapi.ClientWithResponses, execution gatewaydb.ChatExecution, attempt gatewaydb.GatewayGetChatAttemptRow) error {
	if time.Now().Before(attempt.NextAttemptAt) {
		return nil
	}
	payload, err := s.queries.GatewayChatAttemptPayload(ctx, gatewaydb.GatewayChatAttemptPayloadParams{
		ExecutionID: attempt.ExecutionID,
		Number:      attempt.Number,
	})
	if err != nil {
		return err
	}
	if attempt.MessageID == "" {
		attempt.MessageID = fmt.Sprintf("msg_%012x%s", (time.Now().UnixMilli()<<12)&0xffffffffffff, rand.Text()[:14])
	}
	switch execution.Protocol {
	case gatewaydb.ChatProtocolV1:
		var body gatewayapi.SessionPromptAsyncJSONRequestBody
		if err := json.Unmarshal(payload, &body); err != nil {
			return err
		}
		body.MessageID = &attempt.MessageID
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	case gatewaydb.ChatProtocolV2:
		var body gatewayapi.V2SessionPromptJSONRequestBody
		if err := json.Unmarshal(payload, &body); err != nil {
			return err
		}
		body.Id = &attempt.MessageID
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	err = q.GatewayCreateChatExecutionPrompt(ctx, gatewaydb.GatewayCreateChatExecutionPromptParams{
		ExecutionID: execution.ID,
		Attempt:     execution.Attempt,
		MessageID:   attempt.MessageID,
	})
	if err != nil {
		return err
	}
	attempt.Submissions++
	attempt.State = gatewaydb.ChatAttemptStateSubmitting
	err = q.GatewayUpdateChatAttempt(ctx, gatewaydb.GatewayUpdateChatAttemptParams{
		ExecutionID:   attempt.ExecutionID,
		Number:        attempt.Number,
		State:         attempt.State,
		MessageID:     attempt.MessageID,
		Payload:       payload,
		Submissions:   attempt.Submissions,
		NextAttemptAt: time.Now(),
	})
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	current, err := s.queries.GatewayGetChatExecution(ctx, gatewaydb.GatewayGetChatExecutionParams{
		ID:          execution.ID,
		WorkspaceID: execution.WorkspaceID,
	})
	if err != nil {
		return err
	}
	inactive := current.State == gatewaydb.ChatExecutionStateCancelled ||
		current.State == gatewaydb.ChatExecutionStateFailed ||
		current.State == gatewaydb.ChatExecutionStateCompleted ||
		current.Attempt != execution.Attempt ||
		current.LeaseToken != execution.LeaseToken
	if inactive {
		return nil
	}
	var status int
	switch execution.Protocol {
	case gatewaydb.ChatProtocolV1:
		response, err := client.SessionPromptAsyncWithBodyWithResponse(
			ctx,
			execution.AgentName,
			execution.SessionID,
			&gatewayapi.SessionPromptAsyncParams{Directory: &execution.Directory},
			"application/json",
			bytes.NewReader(payload),
		)
		if err != nil {
			return err
		}
		status = response.StatusCode()
	case gatewaydb.ChatProtocolV2:
		response, err := client.V2SessionPromptWithBodyWithResponse(
			ctx,
			execution.AgentName,
			execution.SessionID,
			"application/json",
			bytes.NewReader(payload),
		)
		if err != nil {
			return err
		}
		status = response.StatusCode()
	}
	if status >= 200 && status < 300 {
		return nil
	}
	if status == http.StatusTooManyRequests && attempt.Submissions < 5 {
		delay := min(time.Second<<attempt.Submissions, 30*time.Second)
		return s.queries.GatewayUpdateChatAttempt(ctx, gatewaydb.GatewayUpdateChatAttemptParams{
			ExecutionID:   attempt.ExecutionID,
			Number:        attempt.Number,
			State:         gatewaydb.ChatAttemptStatePending,
			MessageID:     attempt.MessageID,
			Payload:       payload,
			Submissions:   attempt.Submissions,
			NextAttemptAt: time.Now().Add(delay),
		})
	}
	if status >= 400 && status < 500 {
		return s.updateChatExecution(ctx, gatewaydb.GatewayUpdateChatExecutionParams{
			ID:          execution.ID,
			WorkspaceID: execution.WorkspaceID,
			Attempt:     execution.Attempt,
			LeaseToken:  execution.LeaseToken,
			State:       gatewaydb.ChatExecutionStateFailed,
			Reason:      "native_admission_rejected",
			Message:     fmt.Sprintf("The agent rejected prompt admission with HTTP %d", status),
		})
	}
	return fmt.Errorf("native prompt admission returned HTTP %d", status)
}

type workflowRunPromptData struct {
	AgentName    string
	WorkflowName string
	RunName      string
	InputsJSON   string
	Definition   string
	ProgressJSON string
}

// StartWorkflowExecution records one workflow execution before submitting work.
func (s *Service) StartWorkflowExecution(w http.ResponseWriter, r *http.Request, agent string, workflowName string, runName string) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	var input gatewayapi.StartWorkflowExecutionJSONRequestBody
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	run := &agentzv1alpha1.WorkflowRun{}
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: runName}, run)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}
	id, err := uuid.Parse(run.Status.ExecutionID)
	valid := err == nil &&
		string(run.UID) == input.RunUid &&
		run.Spec.AgentName == agent &&
		run.Spec.WorkflowName == workflowName &&
		run.Status.SessionID != "" &&
		run.Status.Phase == agentzv1alpha1.WorkflowRunPhaseRunning &&
		run.DeletionTimestamp.IsZero()
	if !valid {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(http.StatusConflict, "workflow_execution_conflict", "WorkflowRun does not have an active execution binding", err),
		)
		return
	}
	unlock, err := s.lockChatInputs(r.Context(), access.workspaceID, agent, run.Status.SessionID, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	defer unlock()
	existing, err := s.queries.GatewayGetChatExecution(
		r.Context(),
		gatewaydb.GatewayGetChatExecutionParams{ID: id, WorkspaceID: access.workspaceID},
	)
	if err == nil {
		apiutil.WriteJSON(w, http.StatusAccepted, chatExecutionView(existing))
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	var definition []byte
	if run.Spec.Definition == nil {
		saved, err := workflow.Get(r.Context(), s.db, run.Namespace, agent, workflowName)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		definition, err = json.Marshal(saved)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	if run.Spec.Definition != nil {
		definition = run.Spec.Definition.Raw
	}
	var body gatewayapi.SessionPromptAsyncJSONRequestBody
	inputs := "null"
	if len(run.Spec.Inputs.Raw) > 0 {
		inputs = string(run.Spec.Inputs.Raw)
	}
	if run.Spec.Model != nil {
		body.Model = &gatewayapi.OpencodePromptModel{
			ProviderID: run.Spec.Model.ProviderID,
			ModelID:    run.Spec.Model.ModelID,
		}
		if run.Spec.Model.Variant != "" {
			body.Variant = &run.Spec.Model.Variant
		}
	}
	var prompt strings.Builder
	err = gatewayPrompts.ExecuteTemplate(&prompt, "workflowrun.tmpl", workflowRunPromptData{
		AgentName:    agent,
		WorkflowName: workflowName,
		RunName:      runName,
		InputsJSON:   inputs,
		Definition:   string(definition),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	var part gatewayapi.OpencodePromptPartInput
	err = part.FromOpencodeTextPartInput(gatewayapi.OpencodeTextPartInput{
		Type: gatewayapi.OpencodeTextPartInputTypeText,
		Text: prompt.String(),
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	body.Parts = []gatewayapi.OpencodePromptPartInput{part}
	body.Tools = &map[string]bool{"get_workflow": false, "question": false, "set_workflowrun_status": true}
	payload, err := json.Marshal(body)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	client, err := s.agentClient(r.Context(), access.namespace, agent, s.outboundHTTP)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	native, err := client.SessionGetWithResponse(r.Context(), agent, run.Status.SessionID, nil)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if native.JSON200 == nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadGateway, "native_session_missing", "The workflow session is unavailable", nil))
		return
	}
	var deadline pgtype.Timestamptz
	if run.Spec.TimeoutSeconds > 0 && run.Status.StartedAt != nil {
		deadline = pgtype.Timestamptz{
			Time:  run.Status.StartedAt.Add(time.Duration(run.Spec.TimeoutSeconds) * time.Second),
			Valid: true,
		}
	}
	execution, err := s.recordChatPrompt(r.Context(), gatewaydb.GatewayCreateChatExecutionParams{
		ID:              id,
		WorkspaceID:     access.workspaceID,
		AgentName:       agent,
		Namespace:       access.namespace,
		SessionID:       run.Status.SessionID,
		Directory:       native.JSON200.Directory,
		Protocol:        gatewaydb.ChatProtocolV1,
		ActorID:         "workflow:" + input.RunUid,
		ActorName:       runName,
		ActorType:       string(requestActorSystem),
		OrganizationID:  access.organizationID,
		WorkflowRunUid:  input.RunUid,
		WorkflowName:    workflowName,
		WorkflowRunName: runName,
		Definition:      definition,
		Deadline:        deadline,
	}, payload, "")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusAccepted, chatExecutionView(execution))
}

// GetWorkflowExecution reads the execution bound to this WorkflowRun UID.
func (s *Service) GetWorkflowExecution(w http.ResponseWriter, r *http.Request, agent string, workflowName string, runName string) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	run := &agentzv1alpha1.WorkflowRun{}
	err := s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: access.namespace, Name: runName}, run)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}
	if run.Spec.AgentName != agent || run.Spec.WorkflowName != workflowName {
		apiutil.WriteError(w, r, resourceForbidden(workflow.ErrWorkflowRunScopeMismatch))
		return
	}
	result := gatewayapi.ChatExecutionResponse{}
	if run.Status.ExecutionID == "" {
		apiutil.WriteJSON(w, http.StatusOK, result)
		return
	}
	id, err := uuid.Parse(run.Status.ExecutionID)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	execution, err := s.queries.GatewayGetChatExecution(
		r.Context(),
		gatewaydb.GatewayGetChatExecutionParams{ID: id, WorkspaceID: access.workspaceID},
	)
	if err == nil && execution.WorkflowRunUid == string(run.UID) {
		result.Execution = new(chatExecutionView(execution))
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

func (s *Service) trackOpenCodePrompt(r *http.Request, route *opencodeRouteMatch, access resourceAccess, agent string) error {
	session := route.Params["sessionID"]
	protocol := gatewaydb.ChatProtocolV1
	var messageID string
	var payload []byte
	var err error
	switch route.ID {
	case "session.prompt", "session.prompt_async":
		var body gatewayapi.SessionPromptJSONRequestBody
		if err := apiutil.DecodeJSONBody(r, &body, false); err != nil {
			return err
		}
		if body.MessageID == nil {
			body.MessageID = new(fmt.Sprintf("msg_%012x%s", (time.Now().UnixMilli()<<12)&0xffffffffffff, rand.Text()[:14]))
		}
		messageID = *body.MessageID
		if err := replaceOpenCodeRequest(r, body); err != nil {
			return err
		}
		payload, err = json.Marshal(body)
	case "v2.session.prompt":
		protocol = gatewaydb.ChatProtocolV2
		var body gatewayapi.V2SessionPromptJSONRequestBody
		if err := apiutil.DecodeJSONBody(r, &body, false); err != nil {
			return err
		}
		if body.Id == nil {
			body.Id = new(fmt.Sprintf("msg_%012x%s", (time.Now().UnixMilli()<<12)&0xffffffffffff, rand.Text()[:14]))
		}
		messageID = *body.Id
		if err := replaceOpenCodeRequest(r, body); err != nil {
			return err
		}
		payload, err = json.Marshal(body)
	}
	if err != nil {
		return err
	}
	directory := r.URL.Query().Get("directory")
	if directory == "" {
		client, err := s.agentClient(r.Context(), access.namespace, agent, s.outboundHTTP)
		if err != nil {
			return err
		}
		native, err := client.SessionGetWithResponse(r.Context(), agent, session, nil)
		if err != nil {
			return err
		}
		if native.JSON200 == nil {
			return fmt.Errorf("read conversation directory: %s", native.Status())
		}
		directory = native.JSON200.Directory
	}
	auth, _ := requestAuthState(r.Context())
	_, err = s.recordChatPrompt(r.Context(), gatewaydb.GatewayCreateChatExecutionParams{
		WorkspaceID:    access.workspaceID,
		AgentName:      agent,
		Namespace:      access.namespace,
		SessionID:      session,
		Directory:      directory,
		Protocol:       protocol,
		ActorID:        auth.actorID,
		ActorName:      auth.actorName,
		ActorType:      string(auth.actorType),
		UserID:         auth.userID,
		OrganizationID: access.organizationID,
	}, payload, messageID)
	return err
}

type chatObserver struct {
	ready chan struct{}
	err   error
}

// watchChatRuntime subscribes before admission so approvals survive process loss.
func (s *Service) watchChatRuntime(ctx context.Context, namespace string, workspace string, agent string, incarnation string) error {
	key := workspace + "/" + agent + "/" + incarnation
	s.chatObserverMu.Lock()
	observer := s.chatObservers[key]
	if observer == nil {
		observer = &chatObserver{ready: make(chan struct{})}
		if s.chatObservers == nil {
			s.chatObservers = make(map[string]*chatObserver)
		}
		s.chatObservers[key] = observer
		go func() {
			defer func() { s.chatObserverMu.Lock(); delete(s.chatObservers, key); s.chatObserverMu.Unlock() }()
			resolved, err := s.resolver.resolveAgent(s.ctx, namespace, agent)
			if err != nil {
				observer.err = err
				close(observer.ready)
				return
			}
			target, err := openCodeTargetURL(resolved.Target)
			if err != nil {
				observer.err = err
				close(observer.ready)
				return
			}
			request, err := http.NewRequestWithContext(s.ctx, http.MethodGet, target.JoinPath("global/event").String(), nil)
			if err != nil {
				observer.err = err
				close(observer.ready)
				return
			}
			client := *s.outboundHTTP
			client.Timeout = 0
			response, err := client.Do(request)
			if err != nil {
				observer.err = err
				close(observer.ready)
				return
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				observer.err = fmt.Errorf("subscribe to agent events: %s", response.Status)
				close(observer.ready)
				return
			}
			close(observer.ready)
			for frame, err := range sse.Read(response.Body, &sse.ReadConfig{MaxEventSize: opencodeProxyBodyLimitBytes}) {
				if err != nil {
					return
				}
				var envelope gatewayapi.OpencodeGlobalEvent
				if err := json.Unmarshal([]byte(frame.Data), &envelope); err != nil {
					continue
				}
				data, err := envelope.Payload.MarshalJSON()
				if err != nil {
					continue
				}
				var event gatewayapi.OpencodeEvent
				if err := json.Unmarshal(data, &event); err != nil {
					continue
				}
				kind, err := event.Discriminator()
				if err != nil {
					continue
				}
				var session, requestID string
				asked := false
				switch kind {
				case string(gatewayapi.OpencodeEventPermissionAskedTypePermissionAsked):
					value, decodeErr := event.AsOpencodeEventPermissionAsked()
					session, requestID, err, asked = value.Properties.SessionID, value.Properties.Id, decodeErr, true
				case string(gatewayapi.OpencodeEventPermissionV2AskedTypePermissionV2Asked):
					value, decodeErr := event.AsOpencodeEventPermissionV2Asked()
					session, requestID, err, asked = value.Properties.SessionID, value.Properties.Id, decodeErr, true
				case string(gatewayapi.OpencodeEventPermissionV2RepliedTypePermissionV2Replied):
					value, decodeErr := event.AsOpencodeEventPermissionV2Replied()
					session, requestID, err = value.Properties.SessionID, value.Properties.RequestID, decodeErr
				case string(gatewayapi.OpencodeEventQuestionAskedTypeQuestionAsked):
					value, decodeErr := event.AsOpencodeEventQuestionAsked()
					session, requestID, err, asked = value.Properties.SessionID, value.Properties.Id, decodeErr, true
				case string(gatewayapi.OpencodeEventPermissionRepliedTypePermissionReplied):
					value, decodeErr := event.AsOpencodeEventPermissionReplied()
					session, requestID, err = value.Properties.SessionID, value.Properties.RequestID, decodeErr
				case string(gatewayapi.OpencodeEventQuestionRepliedTypeQuestionReplied):
					value, decodeErr := event.AsOpencodeEventQuestionReplied()
					session, requestID, err = value.Properties.SessionID, value.Properties.RequestID, decodeErr
				case string(gatewayapi.OpencodeEventQuestionRejectedTypeQuestionRejected):
					value, decodeErr := event.AsOpencodeEventQuestionRejected()
					session, requestID, err = value.Properties.SessionID, value.Properties.RequestID, decodeErr
				}
				if err != nil || session == "" {
					continue
				}
				err = s.queries.GatewayChatExecutionUserRequest(s.ctx, gatewaydb.GatewayChatExecutionUserRequestParams{
					WorkspaceID: workspace,
					AgentName:   agent,
					SessionID:   session,
					Incarnation: incarnation,
					RequestID:   requestID,
					Asked:       asked,
				})
				if err != nil && s.ctx.Err() == nil {
					slog.ErrorContext(s.ctx, "persist pending user request", "agent", agent, "error", err)
				}
			}
		}()
	}
	s.chatObserverMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-observer.ready:
		return observer.err
	}
}

func (s *Service) updateChatExecution(ctx context.Context, input gatewaydb.GatewayUpdateChatExecutionParams) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	changed, err := q.GatewayUpdateChatExecution(ctx, input)
	if err != nil || changed == 0 {
		return err
	}
	execution, err := q.GatewayGetChatExecution(ctx, gatewaydb.GatewayGetChatExecutionParams{
		ID:          input.ID,
		WorkspaceID: input.WorkspaceID,
	})
	if err != nil {
		return err
	}
	err = q.GatewayFinishChatAttempts(ctx, gatewaydb.GatewayFinishChatAttemptsParams{
		WorkspaceID: execution.WorkspaceID,
		AgentName:   execution.AgentName,
		SessionID:   execution.SessionID,
	})
	if err != nil {
		return err
	}
	err = q.GatewayNotifyChatInputs(ctx, gatewaydb.GatewayNotifyChatInputsParams{
		WorkspaceID: execution.WorkspaceID,
		AgentName:   execution.AgentName,
		SessionID:   pgtype.Text{String: execution.SessionID, Valid: true},
	})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) cancelChatExecution(ctx context.Context, input gatewaydb.GatewayCancelChatExecutionParams) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := gatewaydb.New(tx)
	if _, err := q.GatewayCancelChatExecution(ctx, input); err != nil {
		return err
	}
	err = q.GatewayFinishChatAttempts(ctx, gatewaydb.GatewayFinishChatAttemptsParams{
		WorkspaceID: input.WorkspaceID,
		AgentName:   input.AgentName,
		SessionID:   input.SessionID,
	})
	if err != nil {
		return err
	}
	err = q.GatewayNotifyChatInputs(ctx, gatewaydb.GatewayNotifyChatInputsParams{
		WorkspaceID: input.WorkspaceID,
		AgentName:   input.AgentName,
		SessionID:   pgtype.Text{String: input.SessionID, Valid: true},
	})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
