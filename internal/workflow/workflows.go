package workflow

import (
	"net/http"
	"strings"

	workflowapi "github.com/accuknox/clawarmor/internal/workflow/openapi"
)

// CreateWorkflow handles POST /api/workflows.
func (s *Service) CreateWorkflow(w http.ResponseWriter, r *http.Request) {
	var req workflowapi.CreateWorkflowRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	req.AgentName = strings.TrimSpace(req.AgentName)
	req.WorkflowName = strings.TrimSpace(req.WorkflowName)
	req.Title = strings.TrimSpace(req.Title)
	req.Summary = strings.TrimSpace(req.Summary)
	for idx := range req.Nodes {
		req.Nodes[idx].Name = strings.TrimSpace(req.Nodes[idx].Name)
		req.Nodes[idx].Instructions = strings.TrimSpace(req.Nodes[idx].Instructions)
		req.Nodes[idx].Goal = strings.TrimSpace(req.Nodes[idx].Goal)
		req.Nodes[idx].ExpectedOutput = strings.TrimSpace(req.Nodes[idx].ExpectedOutput)
		req.Nodes[idx].DoneCriteria = strings.TrimSpace(req.Nodes[idx].DoneCriteria)
		for toolIdx := range req.Nodes[idx].PreferredTools {
			req.Nodes[idx].PreferredTools[toolIdx] = strings.TrimSpace(req.Nodes[idx].PreferredTools[toolIdx])
		}
	}
	for idx := range req.Edges {
		req.Edges[idx].Source = strings.TrimSpace(req.Edges[idx].Source)
		req.Edges[idx].Target = strings.TrimSpace(req.Edges[idx].Target)
		req.Edges[idx].BranchLabel = strings.TrimSpace(req.Edges[idx].BranchLabel)
		req.Edges[idx].ConditionSummary = strings.TrimSpace(req.Edges[idx].ConditionSummary)
		req.Edges[idx].CelExpression = strings.TrimSpace(req.Edges[idx].CelExpression)
	}

	fields, err := validateCreateWorkflowRequest(req)
	if err != nil {
		writeInternalError(w, r, err)
		return
	}
	if len(fields) > 0 {
		writeError(w, r, newAPIError(
			http.StatusBadRequest,
			"invalid_request",
			"request validation failed",
			nil,
			fields...,
		))
		return
	}

	row, err := s.store.createWorkflow(r.Context(), req)
	if err != nil {
		writeError(w, r, mapStoreError("create workflow", err))
		return
	}

	writeJSON(w, http.StatusCreated, workflowapi.Workflow{
		AgentName:    req.AgentName,
		WorkflowName: req.WorkflowName,
		Title:        req.Title,
		Summary:      req.Summary,
		Nodes:        req.Nodes,
		Edges:        req.Edges,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	})
}
