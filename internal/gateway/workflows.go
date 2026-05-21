package gateway

import (
	"errors"
	"net/http"
	"strings"

	"github.com/accuknox/clawarmor/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	workflowstore "github.com/accuknox/clawarmor/internal/gateway/workflow"
)

// CreateWorkflow handles POST /api/workflows.
func (s *Service) CreateWorkflow(w http.ResponseWriter, r *http.Request) {
	var req gatewayapi.CreateWorkflowRequest
	if err := apiutil.DecodeJSONBody(w, r, &req, false); err != nil {
		if apiErr, ok := errors.AsType[*apiutil.APIError](err); ok {
			apiutil.WriteError(w, r, apiErr)
			return
		}
		apiutil.WriteInternalError(w, r, err)
		return
	}

	req.AgentName = strings.TrimSpace(req.AgentName)
	req.WorkflowName = strings.TrimSpace(req.WorkflowName)
	req.Title = strings.TrimSpace(req.Title)
	req.Summary = strings.TrimSpace(req.Summary)

	for nodeIndex := range req.Nodes {
		node := &req.Nodes[nodeIndex]
		node.Name = strings.TrimSpace(node.Name)
		node.Instructions = strings.TrimSpace(node.Instructions)
		node.Goal = strings.TrimSpace(node.Goal)
		node.ExpectedOutput = strings.TrimSpace(node.ExpectedOutput)
		node.DoneCriteria = strings.TrimSpace(node.DoneCriteria)

		for toolIndex := range node.PreferredTools {
			node.PreferredTools[toolIndex] = strings.TrimSpace(node.PreferredTools[toolIndex])
		}
	}

	for edgeIndex := range req.Edges {
		edge := &req.Edges[edgeIndex]
		edge.Source = strings.TrimSpace(edge.Source)
		edge.Target = strings.TrimSpace(edge.Target)
		edge.BranchLabel = strings.TrimSpace(edge.BranchLabel)
		edge.ConditionSummary = strings.TrimSpace(edge.ConditionSummary)
		edge.CelExpression = strings.TrimSpace(edge.CelExpression)
	}

	fields, err := workflowstore.ValidateCreateRequest(req)
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

	row, err := workflowstore.Create(r.Context(), s.db, req)
	if err != nil {
		apiutil.WriteError(w, r, workflowstore.MapCreateError(err))
		return
	}

	apiutil.WriteJSON(w, http.StatusCreated, gatewayapi.Workflow{
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

var _ gatewayapi.ServerInterface = (*Service)(nil)
