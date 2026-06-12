package gateway

import (
	"errors"
	"net/http"
	"strings"

	"github.com/accuknox/clawarmor/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	workflowstore "github.com/accuknox/clawarmor/internal/gateway/workflow"
)

// GetWorkflow handles GET /api/workflow/{agentName}/{workflowName}.
func (s *Service) GetWorkflow(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath, workflowName gatewayapi.WorkflowName) {
	agtName = strings.TrimSpace(agtName)
	workflowName = strings.TrimSpace(workflowName)

	fields := workflowstore.ValidateLookupRequest(agtName, workflowName)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	workflow, err := workflowstore.Get(r.Context(), s.db, agtName, workflowName)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapGetError(err))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, workflow)
}

// CreateWorkflow handles POST /api/workflow/{agentName}.
func (s *Service) CreateWorkflow(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	var req gatewayapi.CreateWorkflowRequest
	if err := apiutil.DecodeJSONBody(w, r, &req, false); err != nil {
		if apiErr, ok := errors.AsType[*apiutil.APIError](err); ok {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	req.WorkflowName = strings.TrimSpace(req.WorkflowName)
	req.Title = strings.TrimSpace(req.Title)
	req.Summary = strings.TrimSpace(req.Summary)
	if req.Inputs != nil {
		for name, input := range *req.Inputs {
			if input.Description != nil {
				trimmed := strings.TrimSpace(*input.Description)
				input.Description = &trimmed
			}
			if input.Pattern != nil {
				trimmed := strings.TrimSpace(*input.Pattern)
				input.Pattern = &trimmed
			}
			(*req.Inputs)[name] = input
		}
	}

	for nodeIndex := range req.Nodes {
		node := &req.Nodes[nodeIndex]
		node.Name = strings.TrimSpace(node.Name)
		node.Instructions = strings.TrimSpace(node.Instructions)
		node.Goal = strings.TrimSpace(node.Goal)
		node.DoneCriteria = strings.TrimSpace(node.DoneCriteria)

		if node.PreferredTools != nil {
			for toolIndex, toolName := range *node.PreferredTools {
				(*node.PreferredTools)[toolIndex] = strings.TrimSpace(toolName)
			}
		}
	}

	for edgeIndex := range req.Edges {
		edge := &req.Edges[edgeIndex]
		edge.Source = strings.TrimSpace(edge.Source)
		edge.Target = strings.TrimSpace(edge.Target)
		edge.BranchLabel = strings.TrimSpace(edge.BranchLabel)
		edge.ConditionSummary = strings.TrimSpace(edge.ConditionSummary)
	}

	fields, err := workflowstore.ValidateCreateRequest(agtName, req)
	if err != nil {
		apiutil.WriteInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	row, err := workflowstore.Create(r.Context(), s.db, agtName, req)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapCreateError(err))
		return
	}

	apiutil.WriteJSON(w, http.StatusCreated, gatewayapi.Workflow{
		AgentName:    agtName,
		WorkflowName: req.WorkflowName,
		Title:        req.Title,
		Summary:      req.Summary,
		Nodes:        req.Nodes,
		Edges:        req.Edges,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	})
}

// DeleteWorkflows handles DELETE /api/workflow/{agentName}.
func (s *Service) DeleteWorkflows(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	var req gatewayapi.DeleteWorkflowsRequest
	if err := apiutil.DecodeJSONBody(w, r, &req, false); err != nil {
		if apiErr, ok := errors.AsType[*apiutil.APIError](err); ok {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}

	agtName = strings.TrimSpace(agtName)
	for i := range req.WorkflowNames {
		req.WorkflowNames[i] = strings.TrimSpace(req.WorkflowNames[i])
	}

	fields := workflowstore.ValidateDeleteRequest(agtName, req.WorkflowNames)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	missing, err := workflowstore.DeleteMany(
		r.Context(),
		s.db,
		s.k8sClient,
		s.cfg.Namespace,
		agtName,
		req.WorkflowNames,
	)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapDeleteError(err, missing))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

var _ gatewayapi.ServerInterface = (*Service)(nil)

// ListWorkflowSummaries handles GET /api/workflow/{agentName}.
func (s *Service) ListWorkflowSummaries(w http.ResponseWriter, r *http.Request, agtName gatewayapi.AgentNamePath) {
	agtName = strings.TrimSpace(agtName)

	fields := workflowstore.ValidateListRequest(agtName)
	if len(fields) > 0 {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	summaries, err := workflowstore.ListSummaries(r.Context(), s.db, agtName)
	if err != nil {
		apiutil.WriteError(w, r, apiutil.NewError(
			http.StatusInternalServerError,
			"internal_error",
			"request failed",
			err,
		))
		return
	}

	apiutil.WriteJSON(w, http.StatusOK, summaries)
}
