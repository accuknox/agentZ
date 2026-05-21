package workflow

import (
	"context"
	"encoding/json"
	"fmt"

	workflowdb "github.com/accuknox/clawarmor/internal/workflow/db"
	workflowapi "github.com/accuknox/clawarmor/internal/workflow/openapi"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dbStore struct {
	pool *pgxpool.Pool
}

type storedNode struct {
	NodeName       string `json:"node_name"`
	Ordinal        int32  `json:"ordinal"`
	Instructions   string `json:"instructions"`
	Goal           string `json:"goal"`
	ExpectedOutput string `json:"expected_output"`
	DoneCriteria   string `json:"done_criteria"`
}

type storedPreferredTool struct {
	NodeName string `json:"node_name"`
	Ordinal  int32  `json:"ordinal"`
	ToolName string `json:"tool_name"`
}

type storedEdge struct {
	SourceNodeName   string `json:"source_node_name"`
	TargetNodeName   string `json:"target_node_name"`
	Ordinal          int32  `json:"ordinal"`
	BranchLabel      string `json:"branch_label"`
	ConditionSummary string `json:"condition_summary"`
	CelExpression    string `json:"cel_expression"`
}

func (s *dbStore) createWorkflow(ctx context.Context, req workflowapi.CreateWorkflowRequest) (workflowdb.Workflow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	q := workflowdb.New(tx)
	row, err := q.WorkflowCreate(ctx, workflowdb.WorkflowCreateParams{
		AgentName:    req.AgentName,
		WorkflowName: req.WorkflowName,
		Title:        req.Title,
		Summary:      req.Summary,
	})
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("create workflow: %w", err)
	}

	nodesJSON, preferredToolsJSON, err := marshalNodes(req.Nodes)
	if err != nil {
		return workflowdb.Workflow{}, err
	}

	err = q.WorkflowCreateNodes(ctx, workflowdb.WorkflowCreateNodesParams{
		AgentName:    req.AgentName,
		WorkflowName: req.WorkflowName,
		Nodes:        nodesJSON,
	})
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("create workflow nodes: %w", err)
	}

	if len(preferredToolsJSON) > 0 && string(preferredToolsJSON) != "[]" {
		err = q.WorkflowCreatePreferredTools(ctx, workflowdb.WorkflowCreatePreferredToolsParams{
			AgentName:      req.AgentName,
			WorkflowName:   req.WorkflowName,
			PreferredTools: preferredToolsJSON,
		})
		if err != nil {
			return workflowdb.Workflow{}, fmt.Errorf("create preferred tools: %w", err)
		}
	}

	edgesJSON, err := marshalEdges(req.Edges)
	if err != nil {
		return workflowdb.Workflow{}, err
	}

	if len(req.Edges) > 0 {
		err = q.WorkflowCreateEdges(ctx, workflowdb.WorkflowCreateEdgesParams{
			AgentName:    req.AgentName,
			WorkflowName: req.WorkflowName,
			Edges:        edgesJSON,
		})
		if err != nil {
			return workflowdb.Workflow{}, fmt.Errorf("create workflow edges: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("commit tx: %w", err)
	}
	return row, nil
}

func marshalNodes(nodes []workflowapi.WorkflowNode) ([]byte, []byte, error) {
	storedNodes := make([]storedNode, 0, len(nodes))
	preferredTools := []storedPreferredTool{}
	for idx, node := range nodes {
		ordinal := int32(idx)
		storedNodes = append(storedNodes, storedNode{
			NodeName:       node.Name,
			Ordinal:        ordinal,
			Instructions:   node.Instructions,
			Goal:           node.Goal,
			ExpectedOutput: node.ExpectedOutput,
			DoneCriteria:   node.DoneCriteria,
		})
		for toolIdx, tool := range node.PreferredTools {
			preferredTools = append(preferredTools, storedPreferredTool{
				NodeName: node.Name,
				Ordinal:  int32(toolIdx),
				ToolName: tool,
			})
		}
	}

	nodesJSON, err := json.Marshal(storedNodes)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal workflow nodes: %w", err)
	}
	preferredToolsJSON, err := json.Marshal(preferredTools)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal preferred tools: %w", err)
	}
	return nodesJSON, preferredToolsJSON, nil
}

func marshalEdges(edges []workflowapi.WorkflowEdge) ([]byte, error) {
	storedEdges := make([]storedEdge, 0, len(edges))
	for idx, edge := range edges {
		storedEdges = append(storedEdges, storedEdge{
			SourceNodeName:   edge.Source,
			TargetNodeName:   edge.Target,
			Ordinal:          int32(idx),
			BranchLabel:      edge.BranchLabel,
			ConditionSummary: edge.ConditionSummary,
			CelExpression:    edge.CelExpression,
		})
	}

	edgesJSON, err := json.Marshal(storedEdges)
	if err != nil {
		return nil, fmt.Errorf("marshal workflow edges: %w", err)
	}
	return edgesJSON, nil
}
