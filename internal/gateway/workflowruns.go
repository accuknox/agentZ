package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/accuknox/agentz/internal/authorization"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewaydb "github.com/accuknox/agentz/internal/gateway/db"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

const defaultWebhookTimeoutSeconds int32 = 3600

// PatchWorkflowRunStatus handles PATCH /api/workflow/{agentName}/{workflowName}/run/{runName}/status.
func (s *Service) PatchWorkflowRunStatus(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.PatchWorkflowRunStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)
	boundRun, bindingErr := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, runName)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", bindingErr))
		return
	}

	var message string
	if req.Message != nil {
		message = strings.TrimSpace(*req.Message)
	}

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	fields = append(fields, workflow.ValidateRunTerminalPhase(req.Phase)...)
	fields = append(fields, workflow.ValidateRunStatusMessage(message)...)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conflict",
					"workflow run already has a terminal status",
					err,
				),
			)
		case errors.As(err, &phaseErr):
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conflict",
					err.Error(),
					err,
				),
			)
		default:
			apiutil.WriteError(w, r, mapKubeHTTPError("patch workflow run status", err))
		}
		return
	}

	if boundRun.Spec.Delivery != nil {
		err = s.k8sClient.Get(r.Context(), ctrlclient.ObjectKeyFromObject(boundRun), boundRun)
		if err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
		if err := s.enqueueWorkflowSession(r.Context(), access, boundRun); err != nil {
			apiutil.WriteInternalError(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// PatchWorkflowRunNodeStatus handles PATCH /api/workflow/{agentName}/{workflowName}/run/{runName}/nodes/{nodeName}/status.
func (s *Service) PatchWorkflowRunNodeStatus(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName, nodeName gatewayapi.WorkflowNodeName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.PatchWorkflowRunNodeStatusRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)
	_, bindingErr := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, runName)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", bindingErr))
		return
	}

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
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"workflow not found",
					err,
				),
			)
		case errors.Is(err, workflow.ErrWorkflowRunNodeNotFound):
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"workflow run node not found",
					err,
				),
			)
		case errors.Is(err, workflow.ErrWorkflowRunTerminal):
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conflict",
					"workflow run already has a terminal status",
					err,
				),
			)
		case errors.As(err, &phaseErr):
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conflict",
					err.Error(),
					err,
				),
			)
		case errors.As(err, &nodePhaseErr):
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusConflict,
					"conflict",
					err.Error(),
					err,
				),
			)
		default:
			apiutil.WriteError(w, r, mapKubeHTTPError("patch workflow run node status", err))
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// InvokeWorkflowWebhook handles POST /api/workflow/{agentName}/{workflowName}/webhook.
func (s *Service) InvokeWorkflowWebhook(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.InvokeWorkflowWebhookParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.InvokeWorkflowWebhookJSONRequestBody
	if !decodeJSONBody(w, r, &req, true) {
		return
	}

	auth, ok := requestAuthState(r.Context())
	if !ok || strings.TrimSpace(auth.apiKeyID) == "" {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusUnauthorized,
				"unauthorized",
				"missing or invalid credentials",
				errBadRequest,
			),
		)
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
		fields = append(
			fields,
			gatewayapi.FieldError{
				Field:   "timeout_seconds",
				Message: "must be between 1 and 604800",
			},
		)
	}
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	rawInputs, err := json.Marshal(req)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("marshal webhook inputs: %w", err))
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"workflow not found",
					err,
				),
			)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
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
		apiutil.WriteError(w, r, mapKubeHTTPError("invoke workflow webhook", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusAccepted, resp)
}

// ListWorkflowWebhookTriggers handles GET /api/workflow/{agentName}/webhook.
func (s *Service) ListWorkflowWebhookTriggers(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.ListWorkflowWebhookTriggersParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	fields := workflow.ValidateListRequest(agentName)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"limit must be between 1 and 200",
				errBadRequest,
			),
		)
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
		apiutil.WriteError(w, r, mapKubeHTTPError("list workflow webhook triggers", err))
		return
	}

	resp := gatewayapi.ListWorkflowWebhookTriggersResponse{
		WebhookTriggers: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// ListWorkflowRuns handles GET /api/workflow/{agentName}/{workflowName}/run.
func (s *Service) ListWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.ListWorkflowRunsParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunListFilters(params)...)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
		return
	}

	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	if limit < 1 || limit > 200 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"limit must be between 1 and 200",
				errBadRequest,
			),
		)
		return
	}

	offset, ok := decodeOffsetPageToken(w, r, params.PageToken)
	if !ok {
		return
	}

	destinations, err := s.workflowDestinations(r.Context(), agentName)
	if err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("list workflow destinations", err))
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
		destinations,
	)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("list workflow runs", err))
		return
	}

	resp := gatewayapi.ListWorkflowRunsResponse{WorkflowRuns: items}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// WatchWorkflowRuns handles POST /api/workflow/{agentName}/{workflowName}/run/watch.
//
//nolint:gocyclo
func (s *Service) WatchWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
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
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
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
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusInternalServerError,
				"internal_error",
				"streaming is unavailable",
				nil,
			),
		)
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
			apiutil.RecordRequestError(w, "internal_error", err)
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
		destinations, err := s.workflowDestinations(r.Context(), agentName)
		if err != nil {
			return false
		}
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
				destinations,
			)
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			if err != nil {
				apiutil.RecordRequestError(w, "internal_error", err)
				return false
			}
			for _, item := range listedItems {
				if _, err := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, item.Name); err != nil {
					return false
				}

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
					apiutil.RecordRequestError(w, "internal_error", err)
					return false
				}
				items = append(items, detail)
			}
		}

		for runName := range runFilter {
			if _, err := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, runName); err != nil {
				continue
			}

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
				apiutil.RecordRequestError(w, "internal_error", err)
				return false
			}

			items = append(items, detail)
		}

		changed := make([]gatewayapi.WorkflowRunDetail, 0, len(items))
		for _, item := range items {
			raw, err := json.Marshal(item)
			if err != nil {
				apiutil.RecordRequestError(w, "internal_error", err)
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

				access, apiErr := s.resolveAgentAccess(r.Context(), agentName, authorization.OperationUseSharedAgent)
				if apiErr != nil {
					return
				}
				if evt.Run.Spec.Delivery != nil {
					err = s.authorizeWorkflowDelivery(r.Context(), access, agentName, evt.Run.Spec.Delivery)
					if err != nil {
						return
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
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)
	_, bindingErr := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, runName)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", bindingErr))
		return
	}

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"workflow run not found",
					apierrors.NewNotFound(
						agentzv1alpha1.Resource("workflowrun"),
						runName,
					),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, detail)
}

// DeleteWorkflowRun handles DELETE /api/workflow/{agentName}/{workflowName}/run/{runName}.
func (s *Service) DeleteWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	runName = strings.TrimSpace(runName)
	_, bindingErr := s.getWorkflowRun(r.Context(), ns, agentName, workflowName, runName)
	if bindingErr != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", bindingErr))
		return
	}

	fields := workflow.ValidateLookupRequest(agentName, workflowName)
	fields = append(fields, workflow.ValidateRunName(runName)...)
	if len(fields) > 0 {
		apiutil.WriteError(
			w,
			r,
			apiutil.NewError(
				http.StatusBadRequest,
				"invalid_request",
				"request validation failed",
				errBadRequest,
				fields...,
			),
		)
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
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"workflow run not found",
					apierrors.NewNotFound(
						agentzv1alpha1.Resource("workflowrun"),
						runName,
					),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("delete workflow run", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) getWorkflowRun(ctx context.Context, namespace, agent, workflowName, name string) (*agentzv1alpha1.WorkflowRun, error) {
	run := &agentzv1alpha1.WorkflowRun{}
	err := s.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, run)
	if err != nil {
		return nil, err
	}
	if run.Spec.AgentName != agent || run.Spec.WorkflowName != workflowName {
		return nil, pgx.ErrNoRows
	}
	if run.Spec.Delivery == nil {
		return run, nil
	}
	access, apiErr := s.resolveAgentAccess(ctx, agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		return nil, apiErr
	}
	if err := s.authorizeWorkflowDelivery(ctx, access, agent, run.Spec.Delivery); err != nil {
		return nil, err
	}
	return run, nil
}

// DeliverWorkflowSession hands the root a reference to canonical OpenCode execution history.
func (s *Service) DeliverWorkflowSession(w http.ResponseWriter, r *http.Request, agent, workflowName, name string) {
	namespace, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	run, err := s.getWorkflowRun(r.Context(), namespace, agent, workflowName, name)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}
	access, apiErr := s.resolveAgentAccess(r.Context(), agent, authorization.OperationUseSharedAgent)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	if err := s.enqueueWorkflowSession(r.Context(), access, run); err != nil {
		apiutil.WriteError(w, r, mapGatewayStoreError("deliver workflow session", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) enqueueWorkflowSession(ctx context.Context, access resourceAccess, run *agentzv1alpha1.WorkflowRun) error {
	if run.Spec.Delivery == nil {
		return nil
	}
	release, err := s.lockChatInputs(ctx, access.workspaceID, run.Spec.AgentName, run.Spec.Delivery.SessionID, "")
	if err != nil {
		return err
	}
	defer release()
	if err := s.authorizeWorkflowDelivery(ctx, access, run.Spec.AgentName, run.Spec.Delivery); err != nil {
		return err
	}
	if !run.DeletionTimestamp.IsZero() {
		return pgx.ErrNoRows
	}
	if run.Spec.ScheduleRef != nil {
		schedule := &agentzv1alpha1.WorkflowSchedule{}
		key := ctrlclient.ObjectKey{Namespace: run.Namespace, Name: run.Spec.ScheduleRef.Name}
		err := s.k8sClient.Get(ctx, key, schedule)
		if apierrors.IsNotFound(err) {
			return pgx.ErrNoRows
		}
		if err != nil {
			return err
		}
		// A recreated schedule is a new subscription and cannot revive an old run.
		owner := metav1.GetControllerOf(run)
		if owner == nil || owner.UID != schedule.UID || !schedule.DeletionTimestamp.IsZero() {
			return pgx.ErrNoRows
		}
	}
	if !run.Status.Phase.Terminal() {
		return nil
	}
	aborted := apimeta.FindStatusCondition(run.Status.Conditions, agentzv1alpha1.WorkflowRunConditionSessionAborted)
	if aborted != nil && aborted.Status != metav1.ConditionTrue {
		return nil
	}
	if run.Status.SessionID != "" {
		client, err := s.agentClient(ctx, access.namespace, run.Spec.AgentName, s.outboundHTTP)
		if err != nil {
			return err
		}
		status, err := client.SessionStatusWithResponse(ctx, run.Spec.AgentName, nil)
		if err != nil {
			return err
		}
		if status.JSON200 == nil {
			return errors.New("cannot confirm workflow session completion")
		}
		if state, ok := (*status.JSON200)[run.Status.SessionID]; ok {
			kind, err := state.Discriminator()
			if err != nil {
				return err
			}
			if kind != "idle" {
				return nil
			}
		}
	}
	text := fmt.Sprintf("Workflow %s run %s finished with status %s. OpenCode session: %s.",
		run.Spec.WorkflowName, run.Name, run.Status.Phase, run.Status.SessionID)
	if run.Status.SessionID == "" {
		text = fmt.Sprintf("Workflow %s run %s never started an execution session. %s", run.Spec.WorkflowName, run.Name, run.Status.Message)
	}
	condition := apimeta.FindStatusCondition(run.Status.Conditions, agentzv1alpha1.WorkflowRunConditionReady)
	if condition != nil && condition.Reason == agentzv1alpha1.WorkflowRunReasonCanceled {
		text += " Cancellation was requested. Do not resume or repair this canceled work."
	}
	content, err := json.Marshal(gatewayapi.ChatInputContent{Text: text, Attachments: []gatewayapi.ChatAttachment{}})
	if err != nil {
		return err
	}
	return s.queries.GatewayEnqueueWorkflowSession(ctx, gatewaydb.GatewayEnqueueWorkflowSessionParams{
		WorkspaceID: access.workspaceID,
		AgentName:   run.Spec.AgentName,
		SessionID:   run.Spec.Delivery.SessionID,
		Generation:  run.Spec.Delivery.Generation,
		RunUid:      pgtype.Text{String: string(run.UID), Valid: true},
		Content:     content,
	})
}
