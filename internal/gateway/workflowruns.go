package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const defaultWebhookTimeoutSeconds int32 = 3600

// PatchWorkflowRunStatus handles PATCH /api/workflow/{agentName}/{workflowName}/run/{runName}/status.
func (s *Service) PatchWorkflowRunStatus(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.PatchWorkflowRunStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)

	var message string
	if req.Message != nil {
		message = strings.TrimSpace(*req.Message)
	}

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	fields = append(fields, workflow.ValidateRunTerminalPhase(req.Phase)...)
	fields = append(fields, workflow.ValidateRunStatusMessage(message)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	err = workflow.PatchRunStatus(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		runName,
		req,
		message,
	)
	if err != nil {
		var phaseErr *workflow.RunPhaseConflictError
		switch {
		case errors.Is(err, workflow.ErrWorkflowRunTerminal):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"workflow run already has a terminal status",
				err,
			))
		case errors.As(err, &phaseErr):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				err.Error(),
				err,
			))
		default:
			writeError(w, r, mapKubeHTTPError("patch workflow run status", err))
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// PatchWorkflowRunNodeStatus handles PATCH /api/workflow/{agentName}/{workflowName}/run/{runName}/nodes/{nodeName}/status.
func (s *Service) PatchWorkflowRunNodeStatus(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName, nodeName gatewayapi.WorkflowNodeName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.PatchWorkflowRunNodeStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)
	nodeName = strings.TrimSpace(nodeName)

	var message string
	if req.Message != nil {
		message = strings.TrimSpace(*req.Message)
	}

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	fields = append(fields, workflow.ValidateNodeName(nodeName)...)
	fields = append(fields, workflow.ValidateRunNodePatchPhase(req.Phase)...)
	fields = append(fields, workflow.ValidateRunStatusMessage(message)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	err = workflow.PatchRunNodeStatus(
		r.Context(),
		s.db,
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		runName,
		nodeName,
		req,
		message,
	)
	if err != nil {
		var phaseErr *workflow.RunPhaseConflictError
		var nodePhaseErr *workflow.NodePhaseConflictError
		switch {
		case errors.Is(err, workflow.ErrWorkflowNotFound):
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow not found",
				err,
			))
		case errors.Is(err, workflow.ErrWorkflowRunNodeNotFound):
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow run node not found",
				err,
			))
		case errors.Is(err, workflow.ErrWorkflowRunTerminal):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				"workflow run already has a terminal status",
				err,
			))
		case errors.As(err, &phaseErr):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				err.Error(),
				err,
			))
		case errors.As(err, &nodePhaseErr):
			writeError(w, r, newAPIError(
				http.StatusConflict,
				"conflict",
				err.Error(),
				err,
			))
		default:
			writeError(w, r, mapKubeHTTPError("patch workflow run node status", err))
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// InvokeWorkflowWebhook handles POST /api/workflow/{agentName}/{workflowName}/webhook.
func (s *Service) InvokeWorkflowWebhook(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.InvokeWorkflowWebhookParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.InvokeWorkflowWebhookJSONRequestBody
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	auth, ok := requestAuthState(r.Context())
	if !ok || strings.TrimSpace(auth.apiKeyID) == "" {
		writeError(w, r, newAPIError(
			http.StatusUnauthorized,
			"unauthorized",
			"missing or invalid credentials",
			errBadRequest,
		))
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	timeoutSeconds := defaultWebhookTimeoutSeconds
	if params.TimeoutSeconds != nil {
		timeoutSeconds = *params.TimeoutSeconds
	}
	if timeoutSeconds < 1 || timeoutSeconds > 604800 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "timeout_seconds",
			Message: "must be between 1 and 604800",
		})
	}
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	rawInputs, err := json.Marshal(req)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("marshal webhook inputs: %w", err))
		return
	}

	fields, err = workflow.ValidateRunInputs(
		r.Context(),
		s.db,
		ns,
		agentName,
		workflowName,
		rawInputs,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowNotFound) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow not found",
				err,
			))
			return
		}
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	resp, err := workflow.CreateWebhookRun(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		rawInputs,
		timeoutSeconds,
		auth.apiKeyID,
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("invoke workflow webhook", err))
		return
	}

	writeJSON(w, http.StatusAccepted, resp)
}

// ListWorkflowWebhookTriggers handles GET /api/workflow/{agentName}/webhook.
func (s *Service) ListWorkflowWebhookTriggers(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.ListWorkflowWebhookTriggersParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	fields := workflow.ValidateListRequest(agentName)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	items, nextOffset, err := workflow.ListWebhookTriggers(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		limit,
		offset,
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("list workflow webhook triggers", err))
		return
	}

	resp := gatewayapi.ListWorkflowWebhookTriggersResponse{
		WebhookTriggers: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ListWorkflowRuns handles GET /api/workflow/{agentName}/{workflowName}/run.
func (s *Service) ListWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.ListWorkflowRunsParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunListFilters(params)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"limit must be between 1 and 200",
			errBadRequest,
		))
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	items, nextOffset, err := workflow.ListRuns(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		params,
		limit,
		offset,
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("list workflow runs", err))
		return
	}

	resp := gatewayapi.ListWorkflowRunsResponse{WorkflowRuns: items}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	writeJSON(w, http.StatusOK, resp)
}

// WatchWorkflowRuns handles POST /api/workflow/{agentName}/{workflowName}/run/watch.
//
//nolint:gocyclo
func (s *Service) WatchWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.WatchWorkflowRunsRequest
	if r.Body != nil && !decodeJSONBody(w, r, &req, true) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunWatchNames(req.RunNames)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	runFilter := map[string]struct{}{}
	if req.RunNames != nil {
		for _, runName := range *req.RunNames {
			runFilter[strings.TrimSpace(runName)] = struct{}{}
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, newAPIError(
			http.StatusInternalServerError,
			"internal_error",
			"streaming is unavailable",
			nil,
		))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	prev := make(map[string]gatewayapi.WorkflowRunDetail)
	prevRaw := make(map[string]string)
	send := func(event string, items []gatewayapi.WorkflowRunDetail) bool {
		if len(items) == 0 {
			return true
		}

		raw, err := json.Marshal(gatewayapi.WatchWorkflowRunsEvent{
			WorkflowRuns: items,
		})
		if err != nil {
			recordRequestError(w, "internal_error", err)
			return false
		}
		if event != "" {
			if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
				return false
			}
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	events, cancel := s.resolver.watchWorkflowRuns()
	defer cancel()

	writeChanges := func() bool {
		items := make([]gatewayapi.WorkflowRunDetail, 0, max(1, len(runFilter)))
		if len(runFilter) == 0 {
			listedItems, _, err := workflow.ListRuns(
				r.Context(),
				s.k8sClient,
				ns,
				agentName,
				workflowName,
				gatewayapi.ListWorkflowRunsParams{},
				200,
				0,
			)
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			if err != nil {
				recordRequestError(w, "internal_error", err)
				return false
			}
			for _, item := range listedItems {
				detail, err := workflow.GetRun(
					r.Context(),
					s.k8sClient,
					ns,
					agentName,
					workflowName,
					item.Name,
				)
				if apierrors.IsNotFound(err) || errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
					continue
				}
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return false
				}
				if err != nil {
					recordRequestError(w, "internal_error", err)
					return false
				}
				items = append(items, detail)
			}
		}

		for runName := range runFilter {
			detail, err := workflow.GetRun(
				r.Context(),
				s.k8sClient,
				ns,
				agentName,
				workflowName,
				runName,
			)
			if apierrors.IsNotFound(err) || errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
				continue
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			if err != nil {
				recordRequestError(w, "internal_error", err)
				return false
			}

			items = append(items, detail)
		}

		changed := make([]gatewayapi.WorkflowRunDetail, 0, len(items))
		for _, item := range items {
			raw, err := json.Marshal(item)
			if err != nil {
				recordRequestError(w, "internal_error", err)
				return false
			}
			if prevRaw[item.Name] == string(raw) {
				continue
			}

			prev[item.Name] = item
			prevRaw[item.Name] = string(raw)
			changed = append(changed, item)
		}

		return send("", changed)
	}

	if !writeChanges() {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case evt, ok := <-events:
			if !ok {
				return
			}
			if evt.Type == workflowRunWatchEventDeleted {
				if evt.Run == nil || evt.Run.Namespace != ns {
					continue
				}
				if evt.Run.Spec.AgentName != agentName {
					continue
				}
				if evt.Run.Spec.WorkflowName != workflowName {
					continue
				}
				if len(runFilter) > 0 {
					if _, ok := runFilter[evt.Run.Name]; !ok {
						continue
					}
				}

				item, found := prev[evt.Run.Name]
				delete(prev, evt.Run.Name)
				delete(prevRaw, evt.Run.Name)
				if found && !send("DELETE", []gatewayapi.WorkflowRunDetail{item}) {
					return
				}
				continue
			}
			if !writeChanges() {
				return
			}
		}
	}
}

// GetWorkflowRun handles GET /api/workflow/{agentName}/{workflowName}/run/{runName}.
func (s *Service) GetWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	detail, err := workflow.GetRun(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		runName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow run not found",
				apierrors.NewNotFound(
					agentzv1alpha1.Resource("workflowrun"),
					runName,
				),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}

	writeJSON(w, http.StatusOK, detail)
}

// DeleteWorkflowRun handles DELETE /api/workflow/{agentName}/{workflowName}/run/{runName}.
func (s *Service) DeleteWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			errBadRequest,
			fields...,
		))
		return
	}

	err = workflow.DeleteRun(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		runName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow run not found",
				apierrors.NewNotFound(
					agentzv1alpha1.Resource("workflowrun"),
					runName,
				),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete workflow run", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
