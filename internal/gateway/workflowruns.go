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
	fields = append(fields, workflow.ValidateRunStatusRequest(runName, message)...)
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

// ListWorkflowRuns handles GET /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run.
func (s *Service) ListWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName, params gatewayapi.ListWorkflowRunsParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	schName := strings.TrimSpace(scheduleName)

	fields := workflow.ValidateRunRoute(agtName, workflowName, schName)
	fields = append(fields, workflow.ValidateRunListStatus(params.Status)...)
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
		agtName,
		workflowName,
		schName,
		params.Status,
		limit,
		offset,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowScheduleRefMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow schedule not found",
				apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), schName),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("list workflow runs", err))
		return
	}

	resp := gatewayapi.ListWorkflowRunsResponse{WorkflowRuns: items}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	writeJSON(w, http.StatusOK, resp)
}

// WatchWorkflowRuns handles POST /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run/watch.
//
//nolint:gocyclo
func (s *Service) WatchWorkflowRuns(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	var req gatewayapi.WatchWorkflowRunsRequest
	if r.Body != nil {
		if !decodeJSONBody(w, r, &req, true) {
			return
		}
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	schName := strings.TrimSpace(scheduleName)
	fields := workflow.ValidateRunRoute(agtName, workflowName, schName)
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

	_, _, err = workflow.ListRuns(
		r.Context(),
		s.k8sClient,
		ns,
		agtName,
		workflowName,
		schName,
		nil,
		1,
		0,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowScheduleRefMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow schedule not found",
				err,
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("watch workflow runs", err))
		return
	}

	runFilter := map[string]struct{}{}
	if req.RunNames != nil {
		for _, runName := range *req.RunNames {
			name := strings.TrimSpace(runName)
			runFilter[name] = struct{}{}
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

	prev := make(map[string]gatewayapi.WorkflowRunSummary)
	send := func(event string, items []gatewayapi.WorkflowRunSummary) bool {
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
		items, _, err := workflow.ListRuns(
			r.Context(),
			s.k8sClient,
			ns,
			agtName,
			workflowName,
			schName,
			nil,
			200,
			0,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return false
			}
			recordRequestError(w, "internal_error", err)
			return false
		}

		changed := make([]gatewayapi.WorkflowRunSummary, 0, len(items))
		for _, item := range items {
			if len(runFilter) > 0 {
				if _, ok := runFilter[item.Name]; !ok {
					continue
				}
			}
			prevItem, ok := prev[item.Name]
			durationEqual := prevItem.DurationSeconds == nil && item.DurationSeconds == nil
			if prevItem.DurationSeconds != nil && item.DurationSeconds != nil {
				durationEqual = *prevItem.DurationSeconds == *item.DurationSeconds
			}
			unchanged := ok &&
				prevItem.Name == item.Name &&
				prevItem.WorkflowName == item.WorkflowName &&
				prevItem.Status == item.Status &&
				prevItem.Reason == item.Reason &&
				durationEqual &&
				prevItem.CreatedAt.Equal(item.CreatedAt)
			if unchanged {
				continue
			}
			prev[item.Name] = item
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
				if evt.Run.Spec.AgentName != agtName {
					continue
				}
				if evt.Run.Spec.ScheduleRef == nil || evt.Run.Spec.ScheduleRef.Name != schName {
					continue
				}
				if len(runFilter) > 0 {
					if _, ok := runFilter[evt.Run.Name]; !ok {
						continue
					}
				}

				item, ok := prev[evt.Run.Name]
				delete(prev, evt.Run.Name)
				if ok && !send("DELETE", []gatewayapi.WorkflowRunSummary{item}) {
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

// GetWorkflowRun handles GET /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run/{runName}.
func (s *Service) GetWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	schName := strings.TrimSpace(scheduleName)
	trimmedRunName := strings.TrimSpace(runName)

	fields := workflow.ValidateRunRoute(agtName, workflowName, schName)
	fields = append(fields, workflow.ValidateRunName(trimmedRunName)...)
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
		agtName,
		workflowName,
		schName,
		trimmedRunName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowScheduleRefMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow run not found",
				apierrors.NewNotFound(agentzv1alpha1.Resource("workflowrun"), trimmedRunName),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("get workflow run", err))
		return
	}

	writeJSON(w, http.StatusOK, detail)
}

// DeleteWorkflowRun handles DELETE /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run/{runName}.
func (s *Service) DeleteWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName, runName gatewayapi.WorkflowRunName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		writeInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	schName := strings.TrimSpace(scheduleName)
	trimmedRunName := strings.TrimSpace(runName)

	fields := workflow.ValidateRunRoute(agtName, workflowName, schName)
	fields = append(fields, workflow.ValidateRunName(trimmedRunName)...)
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
		agtName,
		workflowName,
		schName,
		trimmedRunName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowScheduleRefMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"workflow run not found",
				apierrors.NewNotFound(
					agentzv1alpha1.Resource("workflowrun"),
					trimmedRunName,
				),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete workflow run", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
