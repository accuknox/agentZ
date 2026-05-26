package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/gateway/workflow"
	clawarmorv1alpha1 "github.com/accuknox/clawarmor/pkg/apis/clawarmor/v1alpha1"
)

// CreateWorkflowSchedule handles POST /api/workflow-schedules.
func (s *Service) CreateWorkflowSchedule(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	fields := workflow.ValidateScheduleCreateRequest(&req)
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

	fields, err := workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		req.AgentName,
		req.WorkflowName,
		req.Inputs,
	)
	if err != nil {
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

	resp, err := workflow.CreateSchedule(
		r.Context(),
		s.k8sClient,
		s.cfg.Namespace,
		req,
	)
	if err != nil {
		writeError(w, r, mapKubeHTTPError("create workflow schedule", err))
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

// ListWorkflowSchedules handles GET /api/workflow-schedules/{agentName}.
func (s *Service) ListWorkflowSchedules(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, params gatewayapi.ListWorkflowSchedulesParams) {
	agentName := strings.TrimSpace(agtName)
	workflowName, fields := workflow.ValidateScheduleList(agentName, params.WorkflowName)
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

	items, nextOffset, err := workflow.ListSchedules(
		r.Context(),
		s.k8sClient,
		s.cfg.Namespace,
		agentName,
		workflowName,
		limit,
		offset,
	)
	if err != nil {
		writeInternalError(w, r, fmt.Errorf("list workflow schedules: %w", err))
		return
	}

	resp := gatewayapi.ListWorkflowSchedulesResponse{
		WorkflowSchedules: items,
	}
	if nextOffset > 0 {
		resp.NextPageToken = encodeOffsetToken(nextOffset)
	}
	writeJSON(w, http.StatusOK, resp)
}

// DeleteWorkflowSchedule handles DELETE /api/workflow-schedules/{agentName}/{name}.
func (s *Service) DeleteWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, name gatewayapi.WorkflowScheduleName) {
	agentName := strings.TrimSpace(agtName)
	scheduleName := strings.TrimSpace(name)
	fields := workflow.ValidateScheduleLookup(agentName, scheduleName)
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

	err := workflow.DeleteSchedule(
		r.Context(),
		s.k8sClient,
		s.cfg.Namespace,
		agentName,
		scheduleName,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"delete workflow schedule not found",
				apierrors.NewNotFound(
					clawarmorv1alpha1.Resource("workflowschedule"),
					scheduleName,
				),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("delete workflow schedule", err))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateWorkflowSchedule handles PUT /api/workflow-schedules/{agentName}/{name}.
func (s *Service) UpdateWorkflowSchedule(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, name gatewayapi.WorkflowScheduleName) {
	var req gatewayapi.UpdateWorkflowScheduleRequest
	if !decodeJSONBody(w, r, &req, false) {
		return
	}

	agentName := strings.TrimSpace(agtName)
	scheduleName := strings.TrimSpace(name)
	fields := workflow.ValidateScheduleUpdateRequest(
		agentName,
		scheduleName,
		&req,
	)
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

	fields, err := workflow.ValidateScheduleInputs(
		r.Context(),
		s.db,
		agentName,
		req.WorkflowName,
		req.Inputs,
	)
	if err != nil {
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

	resp, err := workflow.UpdateSchedule(
		r.Context(),
		s.k8sClient,
		s.cfg.Namespace,
		agentName,
		scheduleName,
		req,
	)
	if err != nil {
		if errors.Is(err, workflow.ErrScheduleAgentMismatch) {
			writeError(w, r, newAPIError(
				http.StatusNotFound,
				"not_found",
				"update workflow schedule not found",
				apierrors.NewNotFound(
					clawarmorv1alpha1.Resource("workflowschedule"),
					scheduleName,
				),
			))
			return
		}
		writeError(w, r, mapKubeHTTPError("update workflow schedule", err))
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
