package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/accuknox/agentz/internal/gateway/workflow"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

// CreateWorkflowSchedule handles POST /api/workflow/{agentName}/{workflowName}/schedule.
func (s *Service) CreateWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.CreateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateScheduleCreateRequest(agentName, workflowName, &req)
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

	fields, err = workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		ns,
		agentName,
		workflowName,
		req.Inputs,
	)
	if err != nil {
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

	resp, err := workflow.CreateSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		req,
	)
	if err != nil {
		apiutil.WriteError(w, r, mapKubeHTTPError("create workflow schedule", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusCreated, resp)
}

// ListAgentWorkflowSchedules handles GET /api/workflow/{agentName}/schedule.
func (s *Service) ListAgentWorkflowSchedules(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.ListAgentWorkflowSchedulesParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	fields := workflow.ValidateAgentScheduleList(agentName)
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
	sortBy := gatewayapi.WorkflowScheduleSortByQueryWorkflowScheduleSortName
	if params.SortBy != nil {
		sortBy = gatewayapi.WorkflowScheduleSortByQuery(*params.SortBy)
	}
	sortOrder := gatewayapi.SortOrderQueryAsc
	if params.SortOrder != nil {
		sortOrder = gatewayapi.SortOrderQuery(*params.SortOrder)
	}

	items, nextOffset, err := workflow.ListSchedules(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		"",
		sortBy,
		sortOrder,
		limit,
		offset,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("list workflow schedules: %w", err))
		return
	}

	resp := gatewayapi.ListWorkflowSchedulesResponse{
		WorkflowSchedules: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// ListWorkflowSchedules handles GET /api/workflow/{agentName}/{workflowName}/schedule.
func (s *Service) ListWorkflowSchedules(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, params gatewayapi.ListWorkflowSchedulesParams) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	fields := workflow.ValidateScheduleList(agentName, workflowName)
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
	sortBy := gatewayapi.WorkflowScheduleSortByQueryWorkflowScheduleSortName
	if params.SortBy != nil {
		sortBy = gatewayapi.WorkflowScheduleSortByQuery(*params.SortBy)
	}
	sortOrder := gatewayapi.SortOrderQueryAsc
	if params.SortOrder != nil {
		sortOrder = gatewayapi.SortOrderQuery(*params.SortOrder)
	}

	items, nextOffset, err := workflow.ListSchedules(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		sortBy,
		sortOrder,
		limit,
		offset,
	)
	if err != nil {
		apiutil.WriteInternalError(w, r, fmt.Errorf("list workflow schedules: %w", err))
		return
	}

	resp := gatewayapi.ListWorkflowSchedulesResponse{
		WorkflowSchedules: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// DeleteWorkflowSchedule handles DELETE /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}.
func (s *Service) DeleteWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	fields := workflow.ValidateScheduleLookup(agentName, workflowName, scheduleName)
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

	err = workflow.DeleteSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		scheduleName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"delete workflow schedule not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("delete workflow schedule", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateWorkflowSchedule handles PUT /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}.
func (s *Service) UpdateWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	var req gatewayapi.UpdateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	fields := workflow.ValidateScheduleUpdateRequest(
		agentName,
		workflowName,
		scheduleName,
		&req,
	)
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

	fields, err = workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		ns,
		agentName,
		workflowName,
		req.Inputs,
	)
	if err != nil {
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

	resp, err := workflow.UpdateSchedule(
		r.Context(),
		s.k8sClient,
		ns,
		agentName,
		workflowName,
		scheduleName,
		req,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"update workflow schedule not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("update workflow schedule", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, resp)
}

// CreateWorkflowRun handles POST /api/workflow/{agentName}/{workflowName}/schedule/{scheduleName}/run.
func (s *Service) CreateWorkflowRun(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName, scheduleName gatewayapi.WorkflowScheduleName) {
	ns, err := tenantNamespace(r.Context())
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)
	scheduleName = strings.TrimSpace(scheduleName)
	fields := workflow.ValidateScheduleLookup(agtName, workflowName, scheduleName)
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

	connection, apiErr := s.nativeAdmission(r.Context(), ns, agtName)
	if apiErr != nil {
		apiutil.WriteError(w, r, apiErr)
		return
	}
	resp, err := workflow.CreateScheduledRun(
		r.Context(),
		s.k8sClient,
		ns,
		agtName,
		workflowName,
		scheduleName,
		connection,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrWorkflowRunScopeMismatch) {
			apiutil.WriteError(
				w,
				r,
				apiutil.NewError(
					http.StatusNotFound,
					"not_found",
					"create workflow run not found",
					apierrors.NewNotFound(agentzv1alpha1.Resource("workflowschedule"), scheduleName),
				),
			)
			return
		}
		apiutil.WriteError(w, r, mapKubeHTTPError("create workflow run", err))
		return
	}

	apiutil.WriteJSON(w, http.StatusAccepted, resp)
}
