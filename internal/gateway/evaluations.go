package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
	"github.com/accuknox/agentz/internal/scope"
	inputworkflow "github.com/accuknox/agentz/internal/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateWorkflowEvaluation compares model executions on the same workflow and input.
func (s *Service) CreateWorkflowEvaluation(w http.ResponseWriter, r *http.Request, agentName, workflowName string) {
	var input gatewayapi.WorkflowEvaluationRequest
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	definition, err := workflow.Get(r.Context(), s.db, access.namespace, agentName, workflowName)
	if err != nil {
		apiutil.WriteError(w, r, workflow.MapGetError(err))
		return
	}
	fields, err := s.validateEvaluationModels(r.Context(), access.namespace, agentName, input.Models, input.Judge)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	raw, err := json.Marshal(input.Inputs)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	issues, err := inputworkflow.ValidateValues(raw, definition.Inputs, definition.ArbitraryJson, "inputs")
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	for _, issue := range issues {
		fields = append(fields, gatewayapi.FieldError{Field: issue.Field, Message: issue.Message})
	}
	seen := make(map[[3]string]bool)
	for _, model := range input.Models {
		key := [3]string{model.ProviderId, model.ModelId, ""}
		if model.Variant != nil {
			key[2] = *model.Variant
		}
		if seen[key] {
			fields = append(fields, gatewayapi.FieldError{Field: "models", Message: "Select each model configuration once"})
		}
		seen[key] = true
	}
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(400, "invalid_request", "Review the highlighted fields", nil, fields...))
		return
	}
	now := time.Now().UTC()
	result := gatewayapi.WorkflowEvaluation{
		Id: input.Id, Request: input, Workflow: definition,
		State:     gatewayapi.WorkflowEvaluationStateQueued,
		CreatedAt: now, UpdatedAt: now, ScoringVersion: gatewayapi.TraceV1,
		Executions: []gatewayapi.EvaluationExecution{},
	}
	for i, model := range input.Models {
		result.Executions = append(result.Executions, gatewayapi.EvaluationExecution{
			Model: model, RunName: fmt.Sprintf("eval-%s-%d", input.Id, i),
			State: gatewayapi.EvaluationExecutionStateQueued,
		})
	}
	request, err := json.Marshal(input)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	body, err := json.Marshal(result)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	q := workflowdb.New(s.db)
	_, err = q.RunEvaluationCreate(r.Context(), workflowdb.RunEvaluationCreateParams{
		ID:              input.Id,
		TenantNamespace: access.namespace,
		WorkspaceID:     access.workspaceID,
		OrganizationID:  access.organizationID,
		OwnerID:         access.userID,
		AgentName:       agentName,
		WorkflowName:    workflowName,
		Request:         request,
		Result:          body,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		previous, getErr := q.RunEvaluationGet(r.Context(), workflowdb.RunEvaluationGetParams{
			ID:              input.Id,
			TenantNamespace: access.namespace,
			AgentName:       agentName,
			WorkflowName:    workflowName,
		})
		if getErr != nil {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Evaluation ID is already in use", nil))
			return
		}
		var original gatewayapi.WorkflowEvaluationRequest
		if err = json.Unmarshal(previous.Request, &original); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		canonical, marshalErr := json.Marshal(original)
		if marshalErr != nil {
			apiutil.WriteInternalError(w, r, marshalErr)
			return
		}
		if !bytes.Equal(canonical, request) {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Evaluation ID belongs to different settings", nil))
			return
		}
		if err = json.Unmarshal(previous.Result, &result); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusAccepted, result)
}

func (s *Service) validateEvaluationModels(ctx context.Context, namespace, agentName string, models []gatewayapi.EvaluationModel, judge gatewayapi.EvaluationModel) ([]gatewayapi.FieldError, error) {
	resolved, err := s.resolver.resolveAgent(ctx, namespace, agentName)
	if err != nil {
		return nil, err
	}
	ref := resolved.Agent.Spec.SandboxRef
	ns, err := scope.SelectedNamespace(ctx, s.k8sClient, namespace, scope.Selection{
		Scope: ref.Scope, Kind: agentzv1alpha1.OrganizationResourceKindSandbox, Name: ref.Name,
	})
	if err != nil {
		return nil, err
	}
	var sandbox agentzv1alpha1.Sandbox
	if err := s.k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: ref.Name}, &sandbox); err != nil {
		return nil, err
	}
	var fields []gatewayapi.FieldError
	for i, model := range append(slices.Clone(models), judge) {
		available := false
		for _, candidate := range sandbox.Spec.Inference.Models {
			if candidate.Provider == model.ProviderId && candidate.Model == model.ModelId {
				available = true
				break
			}
		}
		if !available {
			field := "models"
			if i == len(models) {
				field = "judge"
			}
			fields = append(fields, gatewayapi.FieldError{
				Field: field, Message: model.Label + " is not available to this agent",
			})
		}
	}
	return fields, nil
}

// ListWorkflowEvaluations lists recent comparisons without loading transcripts into the UI.
func (s *Service) ListWorkflowEvaluations(w http.ResponseWriter, r *http.Request, agentName, workflowName string) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	rows, err := workflowdb.New(s.db).RunEvaluationList(r.Context(), workflowdb.RunEvaluationListParams{
		TenantNamespace: access.namespace,
		AgentName:       agentName,
		WorkflowName:    workflowName,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	results := make([]gatewayapi.WorkflowEvaluationSummary, 0, len(rows))
	for _, row := range rows {
		var result gatewayapi.WorkflowEvaluationSummary
		if err := json.Unmarshal(row, &result); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		results = append(results, result)
	}
	apiutil.WriteJSON(w, 200, results)
}

// GetWorkflowEvaluation returns the frozen inputs, judgments and full native transcripts.
func (s *Service) GetWorkflowEvaluation(w http.ResponseWriter, r *http.Request, agentName, workflowName string, id uuid.UUID) {
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	row, err := workflowdb.New(s.db).RunEvaluationGet(r.Context(), workflowdb.RunEvaluationGetParams{
		ID:              id,
		TenantNamespace: access.namespace,
		AgentName:       agentName,
		WorkflowName:    workflowName,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get evaluation", err))
		return
	}
	var result gatewayapi.WorkflowEvaluation
	if err = json.Unmarshal(row.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	result.State = gatewayapi.WorkflowEvaluationState(row.State)
	if row.CancelRequested && result.State != gatewayapi.WorkflowEvaluationStateCancelled {
		result.State = gatewayapi.WorkflowEvaluationStateCancelling
	}
	apiutil.WriteJSON(w, 200, result)
}

// UpdateWorkflowEvaluation cancels work or judges retained executions with a selected model.
func (s *Service) UpdateWorkflowEvaluation(w http.ResponseWriter, r *http.Request, agentName, workflowName string, id uuid.UUID) {
	var input gatewayapi.UpdateWorkflowEvaluationJSONRequestBody
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	q := workflowdb.New(s.db)
	row, err := q.RunEvaluationGet(r.Context(), workflowdb.RunEvaluationGetParams{
		ID:              id,
		TenantNamespace: access.namespace,
		AgentName:       agentName,
		WorkflowName:    workflowName,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get evaluation", err))
		return
	}
	var result gatewayapi.WorkflowEvaluation
	if err = json.Unmarshal(row.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if input.Action == gatewayapi.Cancel {
		affected, err := q.RunEvaluationCancel(r.Context(), workflowdb.RunEvaluationCancelParams{
			ID:              id,
			TenantNamespace: access.namespace,
			AgentName:       agentName,
			WorkflowName:    workflowName,
		})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if affected == 0 {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "This evaluation is no longer running", nil))
			return
		}
		result.State = gatewayapi.WorkflowEvaluationStateCancelling
		apiutil.WriteJSON(w, 200, result)
		return
	}
	if input.Judge == nil || row.State != "completed" {
		apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Choose a judge after execution finishes", nil))
		return
	}
	fields, err := s.validateEvaluationModels(r.Context(), access.namespace, agentName, nil, *input.Judge)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(400, "invalid_request", "Judge is unavailable", nil, fields...))
		return
	}
	ready := false
	for i := range result.Executions {
		execution := &result.Executions[i]
		if execution.Transcript == nil {
			continue
		}
		execution.State = gatewayapi.EvaluationExecutionStateJudging
		execution.Judgment = nil
		execution.JudgeContextCompacted = nil
		execution.Score = nil
		execution.Message = nil
		ready = true
	}
	if !ready {
		apiutil.WriteError(w, r, apiutil.NewError(409, "no_evidence", "No complete transcripts are available to judge", nil))
		return
	}
	result.Request.Judge = *input.Judge
	result.State = gatewayapi.WorkflowEvaluationStateQueued
	result.UpdatedAt = time.Now().UTC()
	result.Message = nil
	body, err := json.Marshal(result)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	affected, err := q.RunEvaluationRetryJudge(r.Context(), workflowdb.RunEvaluationRetryJudgeParams{
		ID:              id,
		TenantNamespace: access.namespace,
		AgentName:       agentName,
		WorkflowName:    workflowName,
		Result:          body,
		UpdatedAt:       row.UpdatedAt,
	})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if affected == 0 {
		apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Evaluation changed. Refresh and try again.", nil))
		return
	}
	apiutil.WriteJSON(w, 200, result)
}

func (s *Service) runEvaluations(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	q := workflowdb.New(s.db)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		job, err := q.RunEvaluationClaim(ctx, uuid.NewString())
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			slog.ErrorContext(ctx, "claim workflow evaluation", "error", err)
			continue
		}
		var result gatewayapi.WorkflowEvaluation
		if err = json.Unmarshal(job.Result, &result); err != nil {
			slog.ErrorContext(ctx, "decode workflow evaluation", "error", err)
			continue
		}
		step, cancel := context.WithTimeout(ctx, 2*time.Minute)
		done := make(chan struct{})
		go func() {
			defer close(done)
			if job.CancelRequested {
				return
			}
			poll := time.NewTicker(time.Second)
			defer poll.Stop()
			for {
				select {
				case <-step.Done():
					return
				case <-poll.C:
					requested, err := q.RunEvaluationCancelled(step, job.ID)
					if err == nil && requested {
						cancel()
						return
					}
				}
			}
		}()
		err = s.advanceEvaluation(step, job, &result)
		cancel()
		<-done
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "advance workflow evaluation", "id", job.ID, "error", err)
			result.Message = new("Could not reach the agent. Retrying…")
		}
		result.UpdatedAt = time.Now().UTC()
		body, err := json.Marshal(result)
		if err != nil {
			slog.ErrorContext(ctx, "encode workflow evaluation", "error", err)
			continue
		}
		_, err = q.RunEvaluationSave(ctx, workflowdb.RunEvaluationSaveParams{
			ID:         job.ID,
			LeaseToken: job.LeaseToken,
			Result:     body,
			State:      string(result.State),
		})
		if err != nil {
			slog.ErrorContext(ctx, "save workflow evaluation", "error", err)
		}
	}
}

func (s *Service) advanceEvaluation(ctx context.Context, job workflowdb.WorkflowRunEvaluation, result *gatewayapi.WorkflowEvaluation) error {
	result.State = gatewayapi.WorkflowEvaluationStateRunning
	result.Message = nil
	if job.CancelRequested {
		return s.cancelEvaluation(ctx, job, result)
	}
	access := resourceAccess{
		claims:      gatewayClaims{UserID: job.OwnerID, OrganizationID: job.OrganizationID, WorkspaceID: job.WorkspaceID},
		workspaceID: job.WorkspaceID, operation: authorization.OperationUseSharedAgent,
	}
	effective, err := authorization.New(s.queries).Resolve(ctx, authorization.Subject{UserID: job.OwnerID, OrganizationID: job.OrganizationID})
	if err != nil {
		return err
	}
	access.effective = effective
	allowed, err := s.agentOperationAllowed(ctx, access, job.AgentName, authorization.OperationUseSharedAgent)
	if err != nil {
		return err
	}
	if !allowed {
		if err := s.cancelEvaluation(ctx, job, result); err != nil {
			return err
		}
		result.Message = new("Access to this agent was revoked.")
		return nil
	}
	// Finish all executions before freezing metric references and starting judgment.
	for i := range result.Executions {
		execution := &result.Executions[i]
		if execution.State != gatewayapi.EvaluationExecutionStateQueued && execution.State != gatewayapi.EvaluationExecutionStateRunning {
			continue
		}
		var run agentzv1alpha1.WorkflowRun
		err := s.k8sClient.Get(ctx, client.ObjectKey{Namespace: job.TenantNamespace, Name: execution.RunName}, &run)
		if apierrors.IsNotFound(err) && execution.State == gatewayapi.EvaluationExecutionStateQueued {
			definition, err := json.Marshal(result.Workflow)
			if err != nil {
				return err
			}
			inputs, err := json.Marshal(result.Request.Inputs)
			if err != nil {
				return err
			}
			model := &agentzv1alpha1.WorkflowRunModel{ProviderID: execution.Model.ProviderId, ModelID: execution.Model.ModelId}
			if execution.Model.Variant != nil {
				model.Variant = *execution.Model.Variant
			}
			run = agentzv1alpha1.WorkflowRun{
				ObjectMeta: metav1.ObjectMeta{
					Name: execution.RunName, Namespace: job.TenantNamespace,
					Labels: map[string]string{"agentz.accuknox.com/evaluation": result.Id.String()},
				},
				Spec: agentzv1alpha1.WorkflowRunSpec{
					AgentName: job.AgentName, WorkflowName: job.WorkflowName,
					Model: model, Definition: &apiextensionsv1.JSON{Raw: definition},
					Inputs: apiextensionsv1.JSON{Raw: inputs}, TimeoutSeconds: 900,
				},
			}
			if err = s.k8sClient.Create(ctx, &run); err != nil && !apierrors.IsAlreadyExists(err) {
				return err
			}
			execution.State = gatewayapi.EvaluationExecutionStateRunning
			return nil
		}
		if apierrors.IsNotFound(err) {
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("Workflow run is no longer available.")
			return nil
		}
		if err != nil {
			return err
		}
		owned := run.Labels["agentz.accuknox.com/evaluation"] == result.Id.String()
		matches := run.Spec.AgentName == job.AgentName && run.Spec.WorkflowName == job.WorkflowName
		if !owned || !matches {
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("Workflow run does not belong to this evaluation.")
			return nil
		}
		execution.State = gatewayapi.EvaluationExecutionStateRunning
		execution.RunStatus = new(gatewayapi.WorkflowRunStatus(run.Status.Phase))
		if !run.Status.Phase.Terminal() {
			return nil
		}
		if run.Status.SessionID == "" {
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("The run ended before a transcript was recorded.")
			return nil
		}
		detail, err := workflow.GetRun(ctx, s.k8sClient, job.TenantNamespace, job.AgentName, job.WorkflowName, run.Name)
		if err != nil {
			return err
		}
		execution.Run = &detail
		execution.SessionId = &run.Status.SessionID
		if err = s.collectEvaluationTranscript(ctx, job.TenantNamespace, job.AgentName, execution); err != nil {
			if ctx.Err() != nil {
				return err
			}
			if run.Status.CompletedAt != nil && time.Since(run.Status.CompletedAt.Time) < 2*time.Minute {
				return nil
			}
			slog.WarnContext(ctx, "collect evaluation transcript", "run", run.Name, "error", err)
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("The complete execution transcript is unavailable.")
			return nil
		}
		execution.State = gatewayapi.EvaluationExecutionStateJudging
		return nil
	}
	scoreEvaluation(result)
	for i := range result.Executions {
		execution := &result.Executions[i]
		if execution.State != gatewayapi.EvaluationExecutionStateJudging {
			continue
		}
		if err := s.judgeEvaluation(ctx, job.TenantNamespace, result, execution); err != nil {
			if ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return err
			}
			slog.WarnContext(ctx, "judge workflow execution", "run", execution.RunName, "error", err)
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("Judging failed. Retry with a judge that supports the full transcript.")
			return nil
		}
		execution.State = gatewayapi.EvaluationExecutionStateCompleted
		scoreEvaluation(result)
		return nil
	}
	result.State = gatewayapi.WorkflowEvaluationStateCompleted
	return nil
}

func (s *Service) cancelEvaluation(ctx context.Context, job workflowdb.WorkflowRunEvaluation, result *gatewayapi.WorkflowEvaluation) error {
	pending := false
	for i := range result.Executions {
		execution := &result.Executions[i]
		switch execution.State {
		case gatewayapi.EvaluationExecutionStateCompleted, gatewayapi.EvaluationExecutionStateError, gatewayapi.EvaluationExecutionStateCancelled:
			continue
		}
		if execution.State == gatewayapi.EvaluationExecutionStateJudging || execution.State == gatewayapi.EvaluationExecutionStateQueued {
			execution.State = gatewayapi.EvaluationExecutionStateCancelled
			continue
		}
		var run agentzv1alpha1.WorkflowRun
		err := s.k8sClient.Get(ctx, client.ObjectKey{Namespace: job.TenantNamespace, Name: execution.RunName}, &run)
		if apierrors.IsNotFound(err) {
			execution.State = gatewayapi.EvaluationExecutionStateCancelled
			continue
		}
		if err != nil {
			return err
		}
		owned := run.Labels["agentz.accuknox.com/evaluation"] == result.Id.String()
		matches := run.Spec.AgentName == job.AgentName && run.Spec.WorkflowName == job.WorkflowName
		if !owned || !matches {
			execution.State = gatewayapi.EvaluationExecutionStateError
			execution.Message = new("Run identity changed; cancellation skipped.")
			continue
		}
		if err = s.k8sClient.Delete(ctx, &run); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		pending = true
	}
	if !pending {
		result.State = gatewayapi.WorkflowEvaluationStateCancelled
	}
	return nil
}

// evaluationTaskMetadata follows the native task tool's metadata contract.
// The raw metadata is retained separately, including fields not used here.
type evaluationTaskMetadata struct {
	SessionID string `json:"sessionId"`
}

func (s *Service) collectEvaluationTranscript(ctx context.Context, namespace, agent string, execution *gatewayapi.EvaluationExecution) error {
	upstream, err := s.agentClient(ctx, namespace, agent, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return err
	}
	statuses, err := upstream.SessionStatusWithResponse(ctx, agent, nil)
	if err != nil {
		return err
	}
	if statuses.JSON200 == nil {
		return fmt.Errorf("read session status: HTTP %d", statuses.StatusCode())
	}
	sessions := []string{*execution.SessionId}
	seen := map[string]bool{*execution.SessionId: true}
	transcript := []gatewayapi.EvaluationTranscriptSession{}
	var tokens, cost float64
	var calls int
	var started, completed int64
	for index := 0; index < len(sessions); index++ {
		id := sessions[index]
		if status, exists := (*statuses.JSON200)[id]; exists {
			kind, err := status.Discriminator()
			if err != nil {
				return err
			}
			if kind != "idle" {
				return fmt.Errorf("session %s is still active", id)
			}
		}
		session, err := upstream.SessionGetWithResponse(ctx, agent, id, nil)
		if err != nil {
			return err
		}
		if session.JSON200 == nil {
			return fmt.Errorf("read session: HTTP %d", session.StatusCode())
		}
		children, err := upstream.SessionChildrenWithResponse(ctx, agent, id, nil)
		if err != nil {
			return err
		}
		if children.JSON200 == nil {
			return fmt.Errorf("read delegated sessions: HTTP %d", children.StatusCode())
		}
		for _, child := range *children.JSON200 {
			if !seen[child.Id] {
				seen[child.Id] = true
				sessions = append(sessions, child.Id)
			}
		}
		// Omitting limit retrieves all pages in the native session service.
		messages, err := upstream.SessionMessagesWithResponse(ctx, agent, id, nil)
		if err != nil {
			return err
		}
		if messages.JSON200 == nil {
			return fmt.Errorf("read transcript: HTTP %d", messages.StatusCode())
		}
		if len(*messages.JSON200) == 0 {
			return fmt.Errorf("session %s has no transcript", id)
		}
		record := gatewayapi.EvaluationTranscriptSession{SessionId: id, Session: new(gatewayapi.JSONValue)}
		if err = json.Unmarshal(session.Body, record.Session); err != nil {
			return err
		}
		if err = json.Unmarshal(messages.Body, &record.Messages); err != nil {
			return err
		}
		transcript = append(transcript, record)
		answered := false
		for _, message := range *messages.JSON200 {
			role, err := message.Info.Discriminator()
			if err != nil {
				return err
			}
			if role == "user" && index == 0 {
				user, err := message.Info.AsOpencodeUserMessage()
				if err != nil {
					return err
				}
				if started == 0 || user.Time.Created < started {
					started = user.Time.Created
				}
			}
			if role != "assistant" {
				continue
			}
			info, err := message.Info.AsOpencodeAssistantMessage()
			if err != nil {
				return err
			}
			if info.Time.Completed == nil {
				return errors.New("assistant response is incomplete")
			}
			answered = true
			// A resumed task can have earlier history. Keep it as evidence without
			// charging this execution for work completed before its first prompt.
			if int64(info.Time.Created) < started {
				continue
			}
			completed = max(completed, int64(*info.Time.Completed))
			tokens += float64(info.Tokens.Input) + float64(info.Tokens.Output) +
				float64(info.Tokens.Reasoning) + float64(info.Tokens.Cache.Read) +
				float64(info.Tokens.Cache.Write)
			cost += float64(info.Cost)
			for _, part := range message.Parts {
				kind, err := part.Discriminator()
				if err != nil {
					return err
				}
				if kind != "tool" {
					continue
				}
				tool, err := part.AsOpencodeToolPart()
				if err != nil {
					return err
				}
				state, err := tool.State.Discriminator()
				if err != nil {
					return err
				}
				if state != "completed" && state != "error" {
					return fmt.Errorf("tool %s is incomplete", tool.CallID)
				}
				if tool.Tool != "get_workflow" && tool.Tool != "set_workflowrun_status" {
					calls++
				}
				if tool.Tool != "task" || state != "completed" {
					continue
				}
				task, err := tool.State.AsOpencodeToolStateCompleted()
				if err != nil {
					return err
				}
				raw, err := json.Marshal(task.Metadata)
				if err != nil {
					return err
				}
				var metadata evaluationTaskMetadata
				if err = json.Unmarshal(raw, &metadata); err != nil {
					return err
				}
				if metadata.SessionID != "" && !seen[metadata.SessionID] {
					seen[metadata.SessionID] = true
					sessions = append(sessions, metadata.SessionID)
				}
			}
		}
		if !answered {
			return fmt.Errorf("session %s has no completed response", id)
		}
	}
	if started == 0 || completed < started {
		return errors.New("execution timestamps are unavailable")
	}
	// The native runtime substitutes zero for missing provider usage. Zero
	// tokens cannot establish completeness, so leave that metric unavailable.
	execution.Transcript = &transcript
	execution.Cost = &cost
	execution.ToolCalls = &calls
	execution.DurationSeconds = new(float64(completed-started) / 1000)
	if tokens > 0 {
		execution.Tokens = &tokens
	}
	return nil
}

type evaluationJudgeInput struct {
	Workflow  gatewayapi.Workflow             `json:"workflow"`
	Inputs    *gatewayapi.JSONValue           `json:"inputs"`
	Execution *gatewayapi.EvaluationExecution `json:"execution"`
}

func (s *Service) judgeEvaluation(ctx context.Context, namespace string, evaluation *gatewayapi.WorkflowEvaluation, execution *gatewayapi.EvaluationExecution) error {
	upstream, err := s.agentClient(ctx, namespace, evaluation.Workflow.AgentName, &http.Client{Timeout: 110 * time.Second})
	if err != nil {
		return err
	}
	judge := evaluation.Request.Judge
	permissions := gatewayapi.OpencodePermissionRuleset{
		{Permission: "*", Pattern: "*", Action: gatewayapi.OpencodePermissionActionDeny},
		{Permission: "StructuredOutput", Pattern: "*", Action: gatewayapi.OpencodePermissionActionAllow},
	}
	session, err := upstream.SessionCreateWithResponse(ctx, evaluation.Workflow.AgentName, nil, gatewayapi.SessionCreateJSONRequestBody{
		Title:    new("Judge workflow execution"),
		Metadata: &map[string]any{"agentz.evaluation_id": evaluation.Id.String()},
		Model:    &gatewayapi.OpencodeModelRef{ProviderID: judge.ProviderId, Id: judge.ModelId}, Permission: &permissions,
	})
	if err != nil {
		return err
	}
	if session.JSON200 == nil {
		return fmt.Errorf("create judge session: HTTP %d", session.StatusCode())
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		stopped, err := upstream.SessionAbortWithResponse(cleanup, evaluation.Workflow.AgentName, session.JSON200.Id, nil)
		if err != nil || stopped.StatusCode() != http.StatusOK {
			slog.WarnContext(cleanup, "abort judge session", "error", err)
			return
		}
		deleted, err := upstream.SessionDeleteWithResponse(cleanup, evaluation.Workflow.AgentName, session.JSON200.Id, nil)
		if err != nil || deleted.StatusCode() != http.StatusOK {
			slog.WarnContext(cleanup, "delete judge session", "error", err)
		}
	}()
	schema := s.openAPI.Components.Schemas["EvaluationJudgment"].Value
	raw, err := json.Marshal(schema)
	if err != nil {
		return err
	}
	var outputSchema gatewayapi.OpencodeJSONSchema
	if err = json.Unmarshal(raw, &outputSchema); err != nil {
		return err
	}
	var format gatewayapi.OpencodeOutputFormat
	err = format.FromOpencodeOutputFormatJsonSchema(gatewayapi.OpencodeOutputFormatJsonSchema{
		Type: gatewayapi.JsonSchema, Schema: outputSchema, RetryCount: new(1),
	})
	if err != nil {
		return err
	}
	raw, err = json.Marshal(evaluationJudgeInput{
		Workflow: evaluation.Workflow, Inputs: evaluation.Request.Inputs,
		Execution: execution,
	})
	if err != nil {
		return err
	}
	var prompt bytes.Buffer
	if err := gatewayPrompts.ExecuteTemplate(&prompt, "workflow-evaluation.tmpl", string(raw)); err != nil {
		return err
	}

	compacted := false
	for attempt := range 2 {
		var part gatewayapi.OpencodePromptPartInput
		err = part.FromOpencodeTextPartInput(gatewayapi.OpencodeTextPartInput{
			Type: gatewayapi.OpencodeTextPartInputTypeText, Text: prompt.String(),
		})
		if err != nil {
			return err
		}
		messageID := fmt.Sprintf(
			"msg_%012x%s", (time.Now().UnixMilli()<<12)&0xffffffffffff, rand.Text()[:14],
		)
		response, err := upstream.SessionPromptWithResponse(ctx, evaluation.Workflow.AgentName, session.JSON200.Id, nil, gatewayapi.SessionPromptJSONRequestBody{
			MessageID: &messageID,
			Format:    &format, Parts: []gatewayapi.OpencodePromptPartInput{part}, Variant: judge.Variant,
			Model: &gatewayapi.OpencodePromptModel{ProviderID: judge.ProviderId, ModelID: judge.ModelId},
		})
		if err != nil {
			return err
		}
		if response.JSON200 == nil || response.JSON200.Info.Error != nil {
			return errors.New("judge returned no valid response")
		}
		// Native compaction creates a new user message before replay or continuation.
		// Retain this context detail without changing the judgment or its score.
		compacted = compacted || response.JSON200.Info.ParentID != messageID
		execution.JudgeContextCompacted = &compacted
		if compacted && response.JSON200.Info.Structured == nil && attempt == 0 {
			// Native continuation drops the structured-output format. Restore it in
			// the same session so the judge can finish using its compacted context.
			prompt.Reset()
			if err = gatewayPrompts.ExecuteTemplate(&prompt, "workflow-evaluation-resume", nil); err != nil {
				return err
			}
			continue
		}
		if err = schema.VisitJSON(response.JSON200.Info.Structured); err != nil {
			return fmt.Errorf("validate judgment: %w", err)
		}
		raw, err = json.Marshal(response.JSON200.Info.Structured)
		if err != nil {
			return err
		}
		var judgment gatewayapi.EvaluationJudgment
		if err = json.Unmarshal(raw, &judgment); err != nil {
			return err
		}
		execution.Judgment = &judgment
		return nil
	}
	return errors.New("judge did not return a judgment")
}

func scoreEvaluation(evaluation *gatewayapi.WorkflowEvaluation) {
	if evaluation.References == nil {
		var metrics [3][]float64
		for _, execution := range evaluation.Executions {
			if execution.State == gatewayapi.EvaluationExecutionStateQueued || execution.State == gatewayapi.EvaluationExecutionStateRunning {
				return
			}
			if execution.RunStatus == nil || *execution.RunStatus != gatewayapi.WorkflowRunStatusSucceeded {
				continue
			}
			if execution.Tokens == nil || execution.ToolCalls == nil || execution.DurationSeconds == nil {
				continue
			}
			values := []float64{*execution.Tokens, float64(*execution.ToolCalls), *execution.DurationSeconds}
			invalid := slices.ContainsFunc(values, func(value float64) bool {
				return value < 0 || math.IsNaN(value) || math.IsInf(value, 0)
			})
			if invalid {
				continue
			}
			metrics[0] = append(metrics[0], *execution.Tokens)
			metrics[1] = append(metrics[1], float64(*execution.ToolCalls))
			metrics[2] = append(metrics[2], *execution.DurationSeconds)
		}
		if len(metrics[0]) > 0 {
			var medians [3]float64
			for i, values := range metrics {
				slices.Sort(values)
				middle := len(values) / 2
				medians[i] = values[middle]
				if len(values)%2 == 0 {
					medians[i] = (values[middle-1] + values[middle]) / 2
				}
			}
			evaluation.References = &gatewayapi.EvaluationReferences{Tokens: medians[0], ToolCalls: medians[1], DurationSeconds: medians[2]}
		}
	}
	for i := range evaluation.Executions {
		execution := &evaluation.Executions[i]
		execution.Score = nil
		execution.MeasuredEfficiency = nil
		if execution.Tokens == nil || execution.ToolCalls == nil || execution.DurationSeconds == nil {
			continue
		}
		values := [3]float64{*execution.Tokens, float64(*execution.ToolCalls), *execution.DurationSeconds}
		if slices.ContainsFunc(values[:], func(value float64) bool { return value < 0 || math.IsNaN(value) || math.IsInf(value, 0) }) {
			continue
		}
		if evaluation.References != nil {
			ref := evaluation.References
			references := [3]float64{ref.Tokens, ref.ToolCalls, ref.DurationSeconds}
			efficiency := 0.0
			for j, value := range values {
				ratio := 0.5
				if references[j]+value > 0 {
					ratio = references[j] / (references[j] + value)
				}
				efficiency += ratio / 3
			}
			execution.MeasuredEfficiency = &efficiency
		}
		if execution.Judgment == nil || execution.RunStatus == nil {
			continue
		}
		if *execution.RunStatus != gatewayapi.WorkflowRunStatusSucceeded || execution.Judgment.Correctness < 3 {
			execution.Score = new(0.0)
			continue
		}
		if execution.MeasuredEfficiency == nil {
			continue
		}
		quality := float64(execution.Judgment.Correctness) / 4
		efficiency := float64(execution.Judgment.Efficiency) / 4
		execution.Score = new(100 * quality * (0.8 + 0.1*efficiency + 0.1**execution.MeasuredEfficiency))
	}
}
