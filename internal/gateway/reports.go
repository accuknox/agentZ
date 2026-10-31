package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/authorization"
	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

func (s *Service) prepareWorkflowReport(ctx context.Context, access resourceAccess, run *agentzv1alpha1.WorkflowRun, req gatewayapi.PatchWorkflowRunStatusRequest) error {
	if run.Spec.Delivery == nil {
		return nil
	}
	result := req.Result
	if result == nil {
		text := fmt.Sprintf("Workflow %s finished with status %s. This is a status-only update.", run.Spec.WorkflowName, req.Phase)
		if req.Message != nil && *req.Message != "" {
			text += "\n\n" + *req.Message
		}
		result = &gatewayapi.WorkflowResult{Kind: gatewayapi.Update, Text: &text}
	}
	switch result.Kind {
	case gatewayapi.NoChange:
		if req.Phase != gatewayapi.WorkflowRunTerminalPhaseSucceeded {
			return apiutil.NewError(http.StatusBadRequest, "invalid_result", "Only successful runs may report no change", nil)
		}
	case gatewayapi.Update:
		if result.Text == nil || strings.TrimSpace(*result.Text) == "" || len(*result.Text) > 32768 {
			return apiutil.NewError(http.StatusBadRequest, "invalid_result", "An update requires nonempty text of at most 32768 bytes", nil)
		}
		content := gatewayapi.ChatInputContent{Text: *result.Text}
		if result.Artifacts != nil {
			content.Attachments = *result.Artifacts
		}
		if err := validateChatInput(content); err != nil {
			return apiutil.NewError(
				http.StatusBadRequest, "invalid_result", "Workflow artifacts must use valid paths relative to the agent home", err,
			)
		}
	default:
		return apiutil.NewError(http.StatusBadRequest, "invalid_result", "Unknown workflow result kind", nil)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(gatewayapi.PatchWorkflowRunStatusRequest{
		Phase:   req.Phase,
		Message: req.Message,
		Result:  result,
	})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(payload)
	message := ""
	if req.Message != nil {
		message = *req.Message
	}
	_, err = s.queries.GatewayPrepareWorkflowReport(ctx, gatewaydb.GatewayPrepareWorkflowReportParams{
		RunUid:         string(run.UID),
		Namespace:      run.Namespace,
		RunName:        run.Name,
		WorkspaceID:    access.workspaceID,
		AgentName:      run.Spec.AgentName,
		SessionID:      run.Spec.Delivery.SessionID,
		OwnerID:        run.Spec.Delivery.OwnerID,
		Generation:     run.Spec.Delivery.Generation,
		RequestedPhase: string(req.Phase),
		StatusMessage:  message,
		Result:         raw,
		PayloadHash:    hex.EncodeToString(hash[:]),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apiutil.NewError(http.StatusConflict, "report_conflict", "This run already has a different completion receipt", err)
	}
	return err
}

// ReconcileWorkflowReport qualifies a loaded run binding and repairs completion delivery.
// Controllers call it before retention can remove the source execution history.
func (s *Service) ReconcileWorkflowReport(w http.ResponseWriter, r *http.Request, agent, workflowName, name string) {
	namespace, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	run := &agentzv1alpha1.WorkflowRun{}
	err = s.k8sClient.Get(r.Context(), ctrlclient.ObjectKey{Namespace: namespace, Name: name}, run)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}
	if run.Spec.AgentName != agent || run.Spec.WorkflowName != workflowName {
		apiutil.WriteError(w, r, mapGatewayStoreError("get workflow run", pgx.ErrNoRows))
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	auth, _ := requestAuthState(r.Context())
	if run.Spec.Delivery != nil && auth.actorType != requestActorSystem && auth.userID != run.Spec.Delivery.OwnerID {
		apiutil.WriteError(w, r, mapGatewayStoreError("get workflow run", pgx.ErrNoRows))
		return
	}
	if err := s.reconcileWorkflowReport(r.Context(), access, run); err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("reconcile workflow report", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) reconcileWorkflowReport(ctx context.Context, access resourceAccess, run *agentzv1alpha1.WorkflowRun) error {
	if run.Spec.Delivery == nil {
		return nil
	}

	bindingErr := s.authorizeWorkflowDelivery(ctx, access, run.Spec.AgentName, run.Spec.Delivery)
	if bindingErr != nil && !errors.Is(bindingErr, pgx.ErrNoRows) {
		return bindingErr
	}
	report, err := s.queries.GatewayGetWorkflowReport(ctx, string(run.UID))
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !run.Status.Phase.Terminal() {
		if bindingErr != nil {
			return bindingErr
		}
		if err != nil || report.State != "prepared" {
			return nil
		}

		message := report.StatusMessage
		req := gatewayapi.PatchWorkflowRunStatusRequest{
			Phase:   gatewayapi.WorkflowRunTerminalPhase(report.RequestedPhase),
			Message: &message,
		}
		patchErr := workflow.PatchRunStatus(
			ctx, s.k8sClient, run.Namespace, run.Spec.AgentName, run.Spec.WorkflowName, run.Name, req, message,
		)
		if patchErr != nil {
			return patchErr
		}
		if err := s.k8sClient.Get(ctx, ctrlclient.ObjectKeyFromObject(run), run); err != nil {
			return err
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		message := run.Status.Message
		req := gatewayapi.PatchWorkflowRunStatusRequest{
			Phase:   gatewayapi.WorkflowRunTerminalPhase(run.Status.Phase),
			Message: &message,
		}
		if err := s.prepareWorkflowReport(ctx, access, run, req); err != nil {
			return err
		}
		report, err = s.queries.GatewayGetWorkflowReport(ctx, string(run.UID))
		if err != nil {
			return err
		}
	}
	if report.State != "prepared" {
		return nil
	}
	state := ""
	if bindingErr != nil {
		state = "suppressed"
	}
	if report.RequestedPhase != string(run.Status.Phase) {
		state = "conflict"
	}
	var result gatewayapi.WorkflowResult
	if err := json.Unmarshal(report.Result, &result); err != nil {
		return err
	}
	if result.Kind == gatewayapi.NoChange && state == "" {
		state = "suppressed"
	}
	if state != "" {
		return s.queries.GatewaySuppressWorkflowReport(ctx, gatewaydb.GatewaySuppressWorkflowReportParams{
			RunUid: string(run.UID),
			State:  state,
		})
	}
	release, err := s.lockChatInputs(ctx, access.workspaceID, run.Spec.AgentName, run.Spec.Delivery.SessionID, "")
	if err != nil {
		return err
	}
	defer release()
	err = s.authorizeWorkflowDelivery(ctx, access, run.Spec.AgentName, run.Spec.Delivery)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return s.queries.GatewaySuppressWorkflowReport(ctx, gatewaydb.GatewaySuppressWorkflowReportParams{
			RunUid: string(run.UID),
			State:  "suppressed",
		})
	}
	content := gatewayapi.ChatInputContent{
		Text:        *result.Text,
		Attachments: []gatewayapi.ChatAttachment{},
	}
	if result.Artifacts != nil {
		content.Attachments = *result.Artifacts
	}
	if err := validateChatInput(content); err != nil {
		return err
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return err
	}
	_, err = s.queries.GatewayActivateWorkflowReport(ctx, gatewaydb.GatewayActivateWorkflowReportParams{
		RunUid:  string(run.UID),
		Content: raw,
	})
	return err
}
