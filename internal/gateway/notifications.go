package gateway

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
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

// authorizeChat rejects deleted threads and descendants of deleting threads.
func (s *Service) authorizeChat(ctx context.Context, access resourceAccess, agent, session string) (gatewaydb.ChatSession, bool, error) {
	row, err := s.queries.GatewayGetChatSession(ctx, gatewaydb.GatewayGetChatSessionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
		SessionID:   session,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, false, nil
	}
	if err != nil {
		return row, false, err
	}
	if row.Deleting {
		return row, false, pgx.ErrNoRows
	}
	if row.ParentSessionID.Valid {
		root, err := s.queries.GatewayChatRoot(ctx, gatewaydb.GatewayChatRootParams{
			WorkspaceID: access.workspaceID,
			AgentName:   agent,
			SessionID:   session,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return row, false, err
		}
		if root.Deleting {
			return row, false, pgx.ErrNoRows
		}
	}
	return row, row.Kind == gatewaydb.ChatSessionKindChat && !row.ParentSessionID.Valid, nil
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

func (s *Service) guardChat(r *http.Request, access resourceAccess, route *opencodeRouteMatch, agent string) (release func(), err error) {
	if session := route.Params["sessionID"]; session != "" {
		_, _, err := s.authorizeChat(r.Context(), access, agent, session)
		return nil, err
	}
	if route.ID == "session.create" {
		var body gatewayapi.SessionCreateJSONBody
		if err := apiutil.DecodeJSONBody(r, &body, true); err != nil {
			return release, err
		}
		if body.ParentID != nil {
			release, err = s.lockChatInputs(r.Context(), access.workspaceID, agent, *body.ParentID, "")
			if err != nil {
				return release, err
			}
			root, eligible, err := s.authorizeChat(r.Context(), access, agent, *body.ParentID)
			if err != nil {
				return release, err
			}
			auth, _ := requestAuthState(r.Context())
			if eligible && auth.actorType == requestActorSystem {
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
				err = s.authorizeWorkflowDelivery(r.Context(), access, agent, run.Spec.Delivery)
				if err != nil {
					return release, err
				}
			}
		}

		return release, replaceOpenCodeRequest(r, body)
	}
	return nil, nil
}

//go:embed prompts/workflow-notification.md
var workflowNotificationInstruction string

func (s *Service) completeBackgroundInput(ctx context.Context, access resourceAccess, directory string, row gatewaydb.ChatInput) error {
	if row.State == "failed" {
		_, err := s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{ID: row.ID, Error: row.Error})
		if err == nil {
			s.notifyChatInput(ctx, row)
		}
		return err
	}
	client, err := s.agentClient(ctx, access.namespace, row.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	outcome := gatewaydb.ChatBackgroundOutcomeUpdate
	history, err := client.SessionMessagesWithResponse(
		ctx, row.AgentName, row.SessionID, &gatewayapi.SessionMessagesParams{Directory: &directory},
	)
	if err != nil {
		return err
	}
	if history.JSON200 == nil {
		return errors.New("cannot read workflow notification completion")
	}
	superseded := false
	terminal := false
	failed := false
	parentID := row.MessageID
	compactionID := ""
	compacted := false
	started := false
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
			if user.Id == row.MessageID {
				started = true
				continue
			}
			if !started || superseded {
				continue
			}
			auto := false
			continuation := false
			for _, part := range message.Parts {
				kind, err := part.Discriminator()
				if err != nil {
					return err
				}
				switch kind {
				case "compaction":
					value, err := part.AsOpencodeCompactionPart()
					if err != nil {
						return err
					}
					auto = value.Auto
				case "text":
					value, err := part.AsOpencodeTextPart()
					if err != nil {
						return err
					}
					if value.Synthetic != nil && *value.Synthetic && value.Metadata != nil {
						metadata := *value.Metadata
						continuation = metadata["agentz.dev/input-id"] == row.ID.String() || metadata["compaction_continue"] == true
					}
				}
			}
			if auto {
				compactionID = user.Id
				compacted = false
				terminal = false
				continue
			}
			if compacted && continuation {
				parentID = user.Id
				compactionID = ""
				compacted = false
				terminal = false
				failed = false
				text.Reset()
				continue
			}
			superseded = true
			continue
		}
		if kind != "assistant" || !started {
			continue
		}
		assistant, err := message.Info.AsOpencodeAssistantMessage()
		if err != nil {
			return err
		}
		if assistant.Summary != nil && *assistant.Summary {
			compacted = assistant.ParentID == compactionID && assistant.Time.Completed != nil && assistant.Error == nil
			continue
		}
		if assistant.ParentID != parentID || assistant.Time.Completed == nil {
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
	if failed {
		_, err = s.queries.GatewayFailBackgroundInput(ctx, gatewaydb.GatewayFailBackgroundInputParams{
			ID:    row.ID,
			Error: "The agent could not process the workflow notification.",
		})
		return err
	}
	if !terminal {
		if time.Since(row.UpdatedAt) < time.Minute {
			return nil
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
			Error: "The workflow notification ended without a confirmed result. It will not be replayed.",
		})
		return err
	}
	result := strings.TrimSpace(text.String())
	if result == "NO_UPDATE" || strings.HasSuffix(result, "\nNO_UPDATE") {
		outcome = gatewaydb.ChatBackgroundOutcomeQuiet
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
	if root.Kind != gatewaydb.ChatSessionKindChat || root.ParentSessionID.Valid || root.Deleting || root.Generation != delivery.Generation {
		return pgx.ErrNoRows
	}
	return nil
}

// runChatCleanup keeps slow native cleanup independent of message delivery.
func (s *Service) runChatCleanup(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	cursor := ""
	for {
		workCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		var err error
		cursor, err = s.repairChats(workCtx, cursor)
		cancel()
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "repair conversation cleanup", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) repairChats(ctx context.Context, cursor string) (string, error) {
	rows, err := s.queries.GatewayPendingChatCleanup(ctx, cursor)
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
		if !root.Deleting {
			access.userID = row.AuthorID
			executionCtx := context.WithValue(ctx, authContextKey{}, requestAuth{
				claims: &gatewayClaims{
					UserID:         access.userID,
					OrganizationID: access.organizationID,
					WorkspaceID:    access.workspaceID,
				},
				userID:         access.userID,
				actorID:        access.userID,
				actorType:      requestActorUser,
				organizationID: access.organizationID,
				workspaceID:    access.workspaceID,
			})
			client, err := s.agentClient(executionCtx, access.namespace, root.AgentName, s.outboundHTTP)
			if err != nil {
				return cursor, err
			}
			native, err := client.SessionGetWithResponse(executionCtx, root.AgentName, root.SessionID, nil)
			if err != nil {
				return cursor, err
			}
			if native.JSON200 == nil {
				continue
			}
			release, err := s.lockChatInputs(executionCtx, root.WorkspaceID, root.AgentName, root.SessionID, "")
			if err != nil {
				return cursor, err
			}
			stopping, err := s.queries.GatewayChatInputsStopping(executionCtx, gatewaydb.GatewayChatInputsStoppingParams{
				WorkspaceID: root.WorkspaceID,
				AgentName:   root.AgentName,
				SessionID:   root.SessionID,
			})
			if err == nil && stopping {
				err = s.settleChatStop(executionCtx, access, root.AgentName, root.SessionID, native.JSON200.Directory, false)
			}
			release()
			if err != nil {
				slog.ErrorContext(ctx, "recover conversation stop", "session", root.SessionID, "error", err)
			}
			continue
		}
		err = s.cleanChat(ctx, access, root)
		if err != nil {
			slog.ErrorContext(ctx, "clean conversation", "session", root.SessionID, "error", err)
		}
	}
	return cursor, nil
}

func (s *Service) cleanChat(ctx context.Context, access resourceAccess, root gatewaydb.ChatSession) error {
	release, err := s.lockChatInputs(ctx, root.WorkspaceID, root.AgentName, root.SessionID, "")
	if err != nil {
		return err
	}
	defer release()
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
		preconditions := ctrlclient.Preconditions{UID: &schedule.UID, ResourceVersion: &schedule.ResourceVersion}
		err := s.k8sClient.Delete(ctx, schedule, preconditions)
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	// Remove future triggers even when the agent cannot yet stop its sessions.
	client, err := s.agentClient(ctx, access.namespace, root.AgentName, s.outboundHTTP)
	if err != nil {
		return err
	}
	if err := deleteChatSession(ctx, client, root.AgentName, root.SessionID); err != nil {
		return err
	}
	err = s.queries.GatewayDeleteChatSession(ctx, gatewaydb.GatewayDeleteChatSessionParams{
		WorkspaceID:     root.WorkspaceID,
		AgentName:       root.AgentName,
		SessionID:       pgtype.Text{String: root.SessionID, Valid: true},
		TenantNamespace: access.namespace,
	})
	if err != nil {
		return err
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
		preconditions := ctrlclient.Preconditions{UID: &run.UID, ResourceVersion: &run.ResourceVersion}
		err := s.k8sClient.Delete(ctx, run, preconditions)
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return s.queries.GatewayFinishChatCleanup(ctx, gatewaydb.GatewayFinishChatCleanupParams{
		WorkspaceID: root.WorkspaceID,
		AgentName:   root.AgentName,
		SessionID:   root.SessionID,
	})
}

// deleteChatSession removes descendants only after their execution has stopped.
// Callers hold the root admission lock, which also excludes descendant admissions.
func deleteChatSession(ctx context.Context, client *gatewayapi.ClientWithResponses, agent, session string) error {
	aborted, err := client.SessionAbortWithResponse(ctx, agent, session, nil)
	if err != nil {
		return err
	}
	if aborted.StatusCode() == http.StatusNotFound {
		return nil
	}
	if aborted.StatusCode() != http.StatusOK {
		return fmt.Errorf("abort conversation: %s", aborted.Status())
	}
	status, err := client.SessionStatusWithResponse(ctx, agent, nil)
	if err != nil {
		return err
	}
	if status.JSON200 == nil {
		return errors.New("cannot confirm conversation cancellation")
	}
	if state, ok := (*status.JSON200)[session]; ok {
		kind, err := state.Discriminator()
		if err != nil {
			return err
		}
		if kind != "idle" {
			return errors.New("session cancellation is still pending")
		}
	}
	children, err := client.SessionChildrenWithResponse(ctx, agent, session, nil)
	if err != nil {
		return err
	}
	if children.StatusCode() == http.StatusNotFound {
		return nil
	}
	if children.JSON200 == nil {
		return errors.New("cannot read conversation descendants")
	}
	for _, child := range *children.JSON200 {
		if err := deleteChatSession(ctx, client, agent, child.Id); err != nil {
			return fmt.Errorf("delete conversation descendant %s: %w", child.Id, err)
		}
	}
	deleted, err := client.SessionDeleteWithResponse(ctx, agent, session, nil)
	if err != nil {
		return err
	}
	if deleted.StatusCode() != http.StatusOK && deleted.StatusCode() != http.StatusNotFound {
		return fmt.Errorf("delete conversation: %s", deleted.Status())
	}
	return nil
}

// workflowDestinations limits lists before pagination and revalidates open watches.
func (s *Service) workflowDestinations(ctx context.Context, agent string) (map[string]int64, error) {
	access, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		return nil, apiErr
	}
	rows, err := s.queries.GatewayWorkflowDestinations(ctx, gatewaydb.GatewayWorkflowDestinationsParams{
		WorkspaceID: access.workspaceID,
		AgentName:   agent,
	})
	if err != nil {
		return nil, err
	}
	destinations := make(map[string]int64, len(rows))
	for _, row := range rows {
		destinations[row.SessionID] = row.Generation
	}
	return destinations, nil
}
