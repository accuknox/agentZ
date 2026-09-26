package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	"github.com/accuknox/agentz/internal/gateway/evaluatorapi"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
	"github.com/accuknox/agentz/internal/scope"
	inputworkflow "github.com/accuknox/agentz/internal/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateWorkflowEvaluation freezes the definition and persists execution intent.
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
	resolved, err := s.resolver.resolveAgent(r.Context(), access.namespace, agentName)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	ref := resolved.Agent.Spec.SandboxRef
	sandboxNamespace, err := scope.SelectedNamespace(r.Context(), s.k8sClient, access.namespace,
		scope.Selection{Scope: ref.Scope, Kind: agentzv1alpha1.OrganizationResourceKindSandbox, Name: ref.Name})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	var sandbox agentzv1alpha1.Sandbox
	if err := s.k8sClient.Get(r.Context(), client.ObjectKey{Namespace: sandboxNamespace, Name: ref.Name}, &sandbox); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	var fields []gatewayapi.FieldError
	if len(input.Cases)*len(input.Candidates)*input.Repetitions > 1000 {
		fields = append(fields, gatewayapi.FieldError{Field: "cases", Message: "Use at most 1,000 executions per evaluation"})
	}
	if !input.Draft && !input.LiveTools {
		fields = append(fields, gatewayapi.FieldError{Field: "live_tools", Message: "Review and acknowledge execution with this agent's live tools"})
	}
	ids := make(map[string]bool)
	for _, c := range input.Cases {
		if ids[c.Id] {
			fields = append(fields, gatewayapi.FieldError{Field: "cases", Message: "Case IDs must be unique"})
		}
		ids[c.Id] = true
		raw, err := json.Marshal(c.Inputs)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		issues, err := inputworkflow.ValidateValues(raw, definition.Inputs, definition.ArbitraryJson, "cases."+c.Id+".inputs")
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		for _, issue := range issues {
			fields = append(fields, gatewayapi.FieldError{Field: issue.Field, Message: issue.Message})
		}
		if strings.TrimSpace(c.Expected) == "" && strings.TrimSpace(input.Policy.Rubric) == "" {
			fields = append(fields, gatewayapi.FieldError{Field: "cases." + c.Id + ".expected", Message: "Provide an expected output or a quality rubric"})
		}
	}
	clear(ids)
	models := append([]gatewayapi.EvaluationCandidate{}, input.Candidates...)
	if input.Policy.Judge != nil {
		models = append(models, *input.Policy.Judge)
	}
	for _, candidate := range models {
		available := false
		for _, model := range sandbox.Spec.Inference.Models {
			if model.Provider == candidate.ProviderId && model.Model == candidate.ModelId {
				available = true
				break
			}
		}
		if !available {
			fields = append(fields, gatewayapi.FieldError{
				Field: "candidates", Message: candidate.Label + " is not available in this agent's sandbox",
			})
		}
	}
	for _, candidate := range input.Candidates {
		if ids[candidate.Id] {
			fields = append(fields, gatewayapi.FieldError{Field: "candidates", Message: "Model configuration IDs must be unique"})
		}
		ids[candidate.Id] = true
	}
	if input.Policy.Rubric != "" && input.Policy.Judge == nil {
		fields = append(fields, gatewayapi.FieldError{Field: "policy.judge", Message: "Choose a judge for the quality rubric"})
	}
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusBadRequest, "invalid_request", "Review evaluation settings", nil, fields...))
		return
	}
	now := time.Now().UTC()
	result := gatewayapi.WorkflowEvaluation{
		Id: input.Id, AgentName: agentName, WorkflowName: workflowName,
		Request: input, Workflow: definition,
		State:     gatewayapi.WorkflowEvaluationStateQueued,
		CreatedAt: now, UpdatedAt: now, AssessmentRevision: 1,
		Attempts: []gatewayapi.EvaluationAttempt{},
	}
	if input.Draft {
		result.State = gatewayapi.WorkflowEvaluationStateDraft
	}
	for _, c := range input.Cases {
		for repetition := range input.Repetitions {
			for _, candidate := range input.Candidates {
				index := len(result.Attempts)
				result.Attempts = append(result.Attempts, gatewayapi.EvaluationAttempt{
					Id:     fmt.Sprintf("%s-%d", input.Id, index),
					CaseId: c.Id, CandidateId: candidate.Id, Repetition: repetition + 1,
					State:   gatewayapi.EvaluationAttemptStateQueued,
					RunName: fmt.Sprintf("eval-%s-%d", input.Id.String(), index),
					Checks:  []gatewayapi.EvaluationCheck{}, Tools: []gatewayapi.EvaluationTool{},
				})
			}
		}
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
	_, err = q.EvaluationCreate(r.Context(), workflowdb.EvaluationCreateParams{
		ID: input.Id, TenantNamespace: access.namespace,
		WorkspaceID: access.workspaceID, OrganizationID: access.organizationID, OwnerID: access.userID,
		AgentName: agentName, WorkflowName: workflowName,
		State: string(result.State), Request: request, Result: body,
	})
	if err == nil {
		apiutil.WriteJSON(w, http.StatusAccepted, result)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	previous, getErr := q.EvaluationGet(r.Context(), workflowdb.EvaluationGetParams{
		ID: input.Id, TenantNamespace: access.namespace,
		AgentName: agentName, WorkflowName: workflowName,
	})
	if getErr != nil {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "conflict", "Evaluation ID is already in use", nil))
		return
	}
	if previous.State == string(gatewayapi.WorkflowEvaluationStateDraft) {
		result.CreatedAt = previous.CreatedAt
		body, err = json.Marshal(result)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		_, err = q.EvaluationReplaceDraft(r.Context(), workflowdb.EvaluationReplaceDraftParams{
			ID: input.Id, TenantNamespace: access.namespace,
			AgentName: agentName, WorkflowName: workflowName,
			PreviousUpdate: previous.UpdatedAt,
			Request:        request, Result: body, State: string(result.State),
		})
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("save draft", err))
			return
		}
		apiutil.WriteJSON(w, http.StatusAccepted, result)
		return
	}
	var previousInput gatewayapi.WorkflowEvaluationRequest
	if err = json.Unmarshal(previous.Request, &previousInput); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	canonical, marshalErr := json.Marshal(previousInput)
	if marshalErr != nil {
		apiutil.WriteInternalError(w, r, marshalErr)
		return
	}
	if !bytes.Equal(canonical, request) {
		apiutil.WriteError(w, r, apiutil.NewError(http.StatusConflict, "conflict", "Evaluation ID belongs to different settings", nil))
		return
	}
	if err = json.Unmarshal(previous.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusAccepted, result)
}

// ListWorkflowEvaluations returns the selected workflow's recent evaluations.
func (s *Service) ListWorkflowEvaluations(w http.ResponseWriter, r *http.Request, agentName, workflowName string) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	rows, err := workflowdb.New(s.db).EvaluationList(r.Context(), workflowdb.EvaluationListParams{TenantNamespace: ns, AgentName: agentName, WorkflowName: workflowName})
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	results := make([]gatewayapi.WorkflowEvaluationSummary, 0, len(rows))
	for _, row := range rows {
		var result gatewayapi.WorkflowEvaluation
		if err := json.Unmarshal(row.Result, &result); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		completed := 0
		for _, attempt := range result.Attempts {
			switch attempt.State {
			case gatewayapi.EvaluationAttemptStateCompleted, gatewayapi.EvaluationAttemptStateFailed,
				gatewayapi.EvaluationAttemptStateError, gatewayapi.EvaluationAttemptStateCancelled:
				completed++
			}
		}
		results = append(results, gatewayapi.WorkflowEvaluationSummary{
			Id: result.Id, Name: result.Request.Name, State: result.State,
			ModelCount: len(result.Request.Candidates), CaseCount: len(result.Request.Cases),
			Repetitions: result.Request.Repetitions, AttemptCount: len(result.Attempts),
			CompletedCount: completed, CreatedAt: result.CreatedAt, UpdatedAt: result.UpdatedAt,
		})
	}
	apiutil.WriteJSON(w, http.StatusOK, results)
}

// GetWorkflowEvaluation returns immutable inputs and retained execution evidence.
func (s *Service) GetWorkflowEvaluation(w http.ResponseWriter, r *http.Request, agentName, workflowName string, id uuid.UUID) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	row, err := workflowdb.New(s.db).EvaluationGet(r.Context(), workflowdb.EvaluationGetParams{ID: id, TenantNamespace: ns, AgentName: agentName, WorkflowName: workflowName})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get evaluation", err))
		return
	}
	var result gatewayapi.WorkflowEvaluation
	if err = json.Unmarshal(row.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
}

// UpdateWorkflowEvaluation transitions a saved evaluation without rewriting history.
func (s *Service) UpdateWorkflowEvaluation(w http.ResponseWriter, r *http.Request, agentName, workflowName string, id uuid.UUID) {
	var input gatewayapi.UpdateWorkflowEvaluationJSONRequestBody
	if !decodeJSONBody(w, r, &input, false) {
		return
	}
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	q := workflowdb.New(s.db)
	row, err := q.EvaluationGet(r.Context(), workflowdb.EvaluationGetParams{ID: id, TenantNamespace: ns, AgentName: agentName, WorkflowName: workflowName})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("get evaluation", err))
		return
	}
	var result gatewayapi.WorkflowEvaluation
	if err = json.Unmarshal(row.Result, &result); err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	switch input.Action {
	case gatewayapi.Launch:
		if result.State != gatewayapi.WorkflowEvaluationStateDraft || !result.Request.LiveTools {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Only a reviewed draft can be launched", nil))
			return
		}
		result.State = gatewayapi.WorkflowEvaluationStateQueued
	case gatewayapi.Cancel:
		if result.State != gatewayapi.WorkflowEvaluationStateQueued && result.State != gatewayapi.WorkflowEvaluationStateRunning {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Evaluation is not running", nil))
			return
		}
		// Cancellation does not revoke an active lease. The owning worker must
		// finish admission before the cancellation worker can settle its runs.
		_, err = q.EvaluationCancel(r.Context(), workflowdb.EvaluationCancelParams{
			ID: id, TenantNamespace: ns, AgentName: agentName, WorkflowName: workflowName,
		})
		if err != nil {
			apiutil.WriteError(w, r, mapGatewayStoreError("cancel evaluation", err))
			return
		}
		result.Message = "Cancellation requested"
		apiutil.WriteJSON(w, http.StatusAccepted, result)
		return
	case gatewayapi.Regrade:
		if result.State != gatewayapi.WorkflowEvaluationStateCompleted && result.State != gatewayapi.WorkflowEvaluationStateError {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Wait for execution to finish before regrading", nil))
			return
		}
		err = q.EvaluationArchiveAssessment(r.Context(), workflowdb.EvaluationArchiveAssessmentParams{EvaluationID: id, Revision: int32(result.AssessmentRevision), Result: row.Result})
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		result.AssessmentRevision++
		for i := range result.Attempts {
			attempt := &result.Attempts[i]
			if attempt.SessionId != nil && attempt.State != gatewayapi.EvaluationAttemptStateFailed {
				attempt.State = gatewayapi.EvaluationAttemptStateRunning
				if attempt.Tokens != nil {
					attempt.State = gatewayapi.EvaluationAttemptStateGrading
				}
				attempt.Score = nil
				attempt.Quality = nil
				attempt.Grading = nil
				attempt.Checks = []gatewayapi.EvaluationCheck{}
				attempt.Message = ""
			}
		}
		result.State = gatewayapi.WorkflowEvaluationStateQueued
		result.Message = ""
	case gatewayapi.Archive:
		if result.State == gatewayapi.WorkflowEvaluationStateRunning || result.State == gatewayapi.WorkflowEvaluationStateQueued {
			apiutil.WriteError(w, r, apiutil.NewError(409, "conflict", "Cancel execution before archiving", nil))
			return
		}
		result.State = gatewayapi.WorkflowEvaluationStateArchived
	}
	result.UpdatedAt = time.Now().UTC()
	body, err := json.Marshal(result)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	_, err = q.EvaluationTransition(r.Context(), workflowdb.EvaluationTransitionParams{
		ID: id, TenantNamespace: ns, AgentName: agentName, WorkflowName: workflowName,
		State: string(result.State), PreviousUpdate: row.UpdatedAt, Result: body,
	})
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("update evaluation", err))
		return
	}
	apiutil.WriteJSON(w, http.StatusOK, result)
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
		job, err := q.EvaluationClaim(ctx, uuid.NewString())
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			slog.ErrorContext(ctx, "claim evaluation", "error", err)
			continue
		}
		stepCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		var result gatewayapi.WorkflowEvaluation
		err = json.Unmarshal(job.Result, &result)
		if err == nil {
			err = s.advanceEvaluation(stepCtx, job, &result)
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			result.Message = "Evaluation will retry: " + err.Error()
		}
		result.UpdatedAt = time.Now().UTC()
		body, err := json.Marshal(result)
		if err != nil {
			slog.ErrorContext(ctx, "encode evaluation", "error", err)
			continue
		}
		_, err = q.EvaluationSave(ctx, workflowdb.EvaluationSaveParams{ID: job.ID, LeaseToken: job.LeaseToken, Result: body, State: string(result.State)})
		if err != nil {
			slog.ErrorContext(ctx, "save evaluation", "error", err)
		}
	}
}

func (s *Service) advanceEvaluation(ctx context.Context, job workflowdb.WorkflowEvaluation, result *gatewayapi.WorkflowEvaluation) error {
	result.State = gatewayapi.WorkflowEvaluationStateRunning
	if job.CancelRequested {
		return s.cancelEvaluation(ctx, job, result)
	}
	access := resourceAccess{
		claims:      gatewayClaims{UserID: job.OwnerID, OrganizationID: job.OrganizationID, WorkspaceID: job.WorkspaceID},
		workspaceID: job.WorkspaceID,
		operation:   authorization.OperationUseSharedAgent,
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
		result.Message = "Execution stopped because the evaluation owner no longer has access to this agent"
		return nil
	}
	for i := range result.Attempts {
		a := &result.Attempts[i]
		switch a.State {
		case gatewayapi.EvaluationAttemptStateCompleted, gatewayapi.EvaluationAttemptStateFailed,
			gatewayapi.EvaluationAttemptStateError, gatewayapi.EvaluationAttemptStateCancelled:
			continue
		}
		if a.State == gatewayapi.EvaluationAttemptStateGrading {
			return s.gradeEvaluation(ctx, job.TenantNamespace, result, a)
		}
		run := &agentzv1alpha1.WorkflowRun{}
		err := s.k8sClient.Get(ctx, client.ObjectKey{Namespace: job.TenantNamespace, Name: a.RunName}, run)
		if apierrors.IsNotFound(err) && a.State == gatewayapi.EvaluationAttemptStateQueued {
			var candidate gatewayapi.EvaluationCandidate
			for _, c := range result.Request.Candidates {
				if c.Id == a.CandidateId {
					candidate = c
					break
				}
			}
			var testCase gatewayapi.EvaluationCase
			for _, c := range result.Request.Cases {
				if c.Id == a.CaseId {
					testCase = c
					break
				}
			}
			definition, err := json.Marshal(result.Workflow)
			if err != nil {
				return err
			}
			inputs, err := json.Marshal(testCase.Inputs)
			if err != nil {
				return err
			}
			model := &agentzv1alpha1.WorkflowRunModel{ProviderID: candidate.ProviderId, ModelID: candidate.ModelId}
			if candidate.Variant != nil {
				model.Variant = *candidate.Variant
			}
			run = &agentzv1alpha1.WorkflowRun{
				ObjectMeta: metav1.ObjectMeta{
					Name: a.RunName, Namespace: job.TenantNamespace,
					Labels: map[string]string{"agentz.accuknox.com/evaluation": result.Id.String()},
				},
				Spec: agentzv1alpha1.WorkflowRunSpec{
					AgentName: job.AgentName, WorkflowName: job.WorkflowName,
					Model: model, Definition: &apiextensionsv1.JSON{Raw: definition},
					Inputs:         apiextensionsv1.JSON{Raw: inputs},
					TimeoutSeconds: int32(result.Request.TimeoutSeconds),
				},
			}
			err = s.k8sClient.Create(ctx, run)
			if err != nil && !apierrors.IsAlreadyExists(err) {
				return err
			}
			a.State = gatewayapi.EvaluationAttemptStateRunning
			return nil
		}
		if err != nil {
			if !apierrors.IsNotFound(err) {
				return fmt.Errorf("read execution: %w", err)
			}
			a.State = gatewayapi.EvaluationAttemptStateError
			a.Message = "Execution is unavailable: " + err.Error()
			return nil
		}
		if run.Labels["agentz.accuknox.com/evaluation"] != result.Id.String() || run.Spec.AgentName != job.AgentName || run.Spec.WorkflowName != job.WorkflowName {
			a.State = gatewayapi.EvaluationAttemptStateError
			a.Message = "Execution identity does not match this evaluation"
			return nil
		}
		a.State = gatewayapi.EvaluationAttemptStateRunning
		if run.Status.StartedAt != nil {
			a.StartedAt = &run.Status.StartedAt.Time
		}
		if run.Status.SessionID != "" {
			a.SessionId = &run.Status.SessionID
		}
		if !run.Status.Phase.Terminal() {
			return nil
		}
		if run.Status.CompletedAt != nil {
			a.CompletedAt = &run.Status.CompletedAt.Time
		}
		if a.StartedAt != nil && a.CompletedAt != nil {
			duration := a.CompletedAt.Sub(*a.StartedAt).Seconds()
			a.DurationSeconds = &duration
		}
		if run.Status.Phase != agentzv1alpha1.WorkflowRunPhaseSucceeded {
			a.State = gatewayapi.EvaluationAttemptStateFailed
			a.Score = new(float64(0))
			a.Quality = new(float64(0))
			a.Message = run.Status.Message
		}
		if a.SessionId == nil {
			a.State = gatewayapi.EvaluationAttemptStateError
			a.Message = "Execution has no session evidence"
			return nil
		}
		if err = s.collectEvaluationEvidence(ctx, job.TenantNamespace, job.AgentName, a); err != nil {
			a.Message = err.Error()
			if run.Status.Phase != agentzv1alpha1.WorkflowRunPhaseSucceeded {
				a.Message = run.Status.Message + "; " + err.Error()
			}
			if a.CompletedAt != nil && time.Since(*a.CompletedAt) < 2*time.Minute {
				a.State = gatewayapi.EvaluationAttemptStateRunning
				return nil
			}
			if run.Status.Phase == agentzv1alpha1.WorkflowRunPhaseSucceeded {
				a.State = gatewayapi.EvaluationAttemptStateError
			}
			return nil
		}
		if a.State != gatewayapi.EvaluationAttemptStateFailed {
			a.State = gatewayapi.EvaluationAttemptStateGrading
		}
		return nil
	}
	result.State = gatewayapi.WorkflowEvaluationStateCompleted
	for _, a := range result.Attempts {
		if a.State == gatewayapi.EvaluationAttemptStateError {
			result.State = gatewayapi.WorkflowEvaluationStateError
			result.Message = "Some attempts could not be scored. Inspect their errors before comparing models."
			break
		}
	}
	return nil
}

// cancelEvaluation waits for the controller finalizer to abort every admitted
// session before reporting cancellation. Runs belonging to another evaluation
// are never deleted, even if an external actor reused their names.
func (s *Service) cancelEvaluation(ctx context.Context, job workflowdb.WorkflowEvaluation, result *gatewayapi.WorkflowEvaluation) error {
	pending := false
	for i := range result.Attempts {
		a := &result.Attempts[i]
		if a.State == gatewayapi.EvaluationAttemptStateCompleted || a.State == gatewayapi.EvaluationAttemptStateFailed || a.State == gatewayapi.EvaluationAttemptStateCancelled {
			continue
		}
		run := &agentzv1alpha1.WorkflowRun{}
		err := s.k8sClient.Get(ctx, client.ObjectKey{Namespace: job.TenantNamespace, Name: a.RunName}, run)
		if apierrors.IsNotFound(err) {
			a.State = gatewayapi.EvaluationAttemptStateCancelled
			continue
		}
		if err != nil {
			return fmt.Errorf("find execution to cancel: %w", err)
		}
		if run.Labels["agentz.accuknox.com/evaluation"] != result.Id.String() || run.Spec.AgentName != job.AgentName || run.Spec.WorkflowName != job.WorkflowName {
			a.State = gatewayapi.EvaluationAttemptStateCancelled
			a.Message = "Conflicting execution belongs to another evaluation"
			continue
		}
		pending = true
		if run.DeletionTimestamp.IsZero() {
			if err := s.k8sClient.Delete(ctx, run); err != nil && !apierrors.IsNotFound(err) {
				return fmt.Errorf("cancel execution: %w", err)
			}
		}
	}
	if !pending {
		result.State = gatewayapi.WorkflowEvaluationStateCancelled
		result.Message = "Evaluation cancelled"
	}
	return nil
}

func (s *Service) collectEvaluationEvidence(ctx context.Context, namespace, agent string, a *gatewayapi.EvaluationAttempt) error {
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
	var tokens, cost float64
	var taskCalls, protocolCalls int
	var firstPrompt, lastCompletion int64
	a.Tools = []gatewayapi.EvaluationTool{}
	a.Output = ""
	models := []string{}
	sessions := []string{*a.SessionId}
	seen := map[string]bool{*a.SessionId: true}
	for index := 0; index < len(sessions); index++ {
		sessionID := sessions[index]
		if status, exists := (*statuses.JSON200)[sessionID]; exists {
			kind, err := status.Discriminator()
			if err != nil {
				return err
			}
			if kind != "idle" {
				return errors.New("session is still running; waiting for final evidence")
			}
		}
		children, err := upstream.SessionChildrenWithResponse(ctx, agent, sessionID, nil)
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
		response, err := upstream.SessionMessagesWithResponse(ctx, agent, sessionID, nil)
		if err != nil {
			return err
		}
		if response.JSON200 == nil {
			return fmt.Errorf("read session evidence: HTTP %d", response.StatusCode())
		}
		previousTokens := tokens
		for _, message := range *response.JSON200 {
			kind, err := message.Info.Discriminator()
			if err != nil {
				return err
			}
			if kind == "user" {
				info, err := message.Info.AsOpencodeUserMessage()
				if err != nil {
					return err
				}
				created := int64(info.Time.Created)
				if firstPrompt == 0 || created < firstPrompt {
					firstPrompt = created
				}
				continue
			}
			if kind != "assistant" {
				continue
			}
			info, err := message.Info.AsOpencodeAssistantMessage()
			if err != nil {
				return err
			}
			if info.Time.Completed == nil {
				return errors.New("session evidence is still being written; retry grading after completion")
			}
			lastCompletion = max(lastCompletion, int64(*info.Time.Completed))
			model := info.ProviderID + "/" + info.ModelID
			if !slices.Contains(models, model) {
				models = append(models, model)
			}
			tokens += float64(info.Tokens.Input) + float64(info.Tokens.Output) + float64(info.Tokens.Reasoning) + float64(info.Tokens.Cache.Read) + float64(info.Tokens.Cache.Write)
			cost += float64(info.Cost)
			var output strings.Builder
			for _, part := range message.Parts {
				kind, err := part.Discriminator()
				if err != nil {
					return err
				}
				switch kind {
				case "text":
					text, err := part.AsOpencodeTextPart()
					if err != nil {
						return err
					}
					output.WriteString(text.Text)
				case "tool":
					tool, err := part.AsOpencodeToolPart()
					if err != nil {
						return err
					}
					state, err := tool.State.Discriminator()
					if err != nil {
						return err
					}
					item := gatewayapi.EvaluationTool{Id: sessionID + ":" + tool.CallID, Name: tool.Tool, State: state, SessionId: &sessionID}
					switch state {
					case "completed":
						value, err := tool.State.AsOpencodeToolStateCompleted()
						if err != nil {
							return err
						}
						raw, err := json.Marshal(value.Input)
						if err != nil {
							return err
						}
						item.Input = string(raw)
						item.Output = value.Output
					case "error":
						value, err := tool.State.AsOpencodeToolStateError()
						if err != nil {
							return err
						}
						raw, err := json.Marshal(value.Input)
						if err != nil {
							return err
						}
						item.Input = string(raw)
						item.Output = value.Error
					default:
						return errors.New("tool evidence is incomplete")
					}
					a.Tools = append(a.Tools, item)
					if tool.Tool == "set_workflowrun_status" || tool.Tool == "get_workflow" {
						protocolCalls++
						continue
					}
					taskCalls++
				}
			}
			if sessionID == *a.SessionId {
				a.Output = output.String()
			}
		}
		if tokens == previousTokens {
			return errors.New("no complete model usage was recorded for a session; score is unavailable")
		}
	}
	a.ModelsUsed = &models
	if firstPrompt > 0 && lastCompletion >= firstPrompt {
		started := time.UnixMilli(firstPrompt).UTC()
		completed := time.UnixMilli(lastCompletion).UTC()
		duration := completed.Sub(started).Seconds()
		a.StartedAt = &started
		a.CompletedAt = &completed
		a.DurationSeconds = &duration
	}
	a.Tokens = &tokens
	a.Cost = &cost
	a.TaskCalls = &taskCalls
	a.ProtocolCalls = &protocolCalls
	return nil
}

func (s *Service) gradeEvaluation(ctx context.Context, namespace string, evaluation *gatewayapi.WorkflowEvaluation, a *gatewayapi.EvaluationAttempt) error {
	var testCase gatewayapi.EvaluationCase
	for _, c := range evaluation.Request.Cases {
		if c.Id == a.CaseId {
			testCase = c
			break
		}
	}
	resolved, err := s.resolver.resolveAgent(ctx, namespace, evaluation.AgentName)
	if err != nil {
		return err
	}
	target, err := openCodeTargetURL(resolved.Target)
	if err != nil {
		return err
	}
	request := evaluatorapi.GradeRequest{Target: target.String(), Output: a.Output, Expected: testCase.Expected, Policy: evaluation.Request.Policy}
	grader, err := evaluatorapi.NewClientWithResponses(s.cfg.EvaluationGraderURL,
		evaluatorapi.WithHTTPClient(&http.Client{Timeout: 40 * time.Second}))
	if err != nil {
		return fmt.Errorf("configure grader: %w", err)
	}
	response, err := grader.GradeEvaluationWithResponse(ctx, request)
	if err != nil {
		a.State = gatewayapi.EvaluationAttemptStateError
		a.Message = "Grading service unavailable: " + err.Error()
		return nil
	}
	if response.JSON200 == nil {
		a.State = gatewayapi.EvaluationAttemptStateError
		a.Message = fmt.Sprintf("Grading failed: HTTP %d", response.StatusCode())
		if response.JSON422 != nil {
			a.Message = "Grading failed: " + response.JSON422.Message
		}
		return nil
	}
	grade := *response.JSON200
	if len(grade.Checks) == 0 || grade.Quality < 0 || grade.Quality > 1 || math.IsNaN(grade.Quality) {
		a.State = gatewayapi.EvaluationAttemptStateError
		a.Message = "Grader returned an invalid score"
		return nil
	}
	a.Checks = grade.Checks
	a.Grading = &grade
	quality := grade.Quality
	a.Quality = &quality
	score, err := evaluationScore(evaluation.Request.Policy, grade, *a)
	if err != nil {
		a.State = gatewayapi.EvaluationAttemptStateError
		a.Message = err.Error()
		return nil
	}
	a.Score = &score
	a.State = gatewayapi.EvaluationAttemptStateCompleted
	a.Message = ""
	return nil
}

// evaluationScore applies frozen reference values, independent of the display
// baseline and other candidates. Failed correctness checks always earn zero.
func evaluationScore(policy gatewayapi.EvaluationPolicy, grade gatewayapi.EvaluationGradeResult, attempt gatewayapi.EvaluationAttempt) (float64, error) {
	if attempt.Tokens == nil || attempt.TaskCalls == nil || attempt.DurationSeconds == nil {
		return 0, errors.New("resource evidence is incomplete")
	}
	if grade.Quality < policy.MinimumQuality {
		return 0, nil
	}
	for _, check := range grade.Checks {
		if !check.Passed {
			return 0, nil
		}
	}
	tokens := min(1, policy.TokenReference/max(1, *attempt.Tokens))
	tools := min(1, policy.ToolReference/max(1, float64(*attempt.TaskCalls)))
	duration := min(1, policy.DurationReference/max(1, *attempt.DurationSeconds))
	efficiency := (tokens + tools + duration) / 3
	score := 100 * grade.Quality * (1 - policy.EfficiencyWeight + policy.EfficiencyWeight*efficiency)
	return math.Round(score*100) / 100, nil
}
