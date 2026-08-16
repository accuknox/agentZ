package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
)

var ErrWorkflowNotFound = errors.New("workflow not found")

type storedNode struct {
	NodeName     string `json:"node_name"`
	Ordinal      int32  `json:"ordinal"`
	Instructions string `json:"instructions"`
	Goal         string `json:"goal"`
	DoneCriteria string `json:"done_criteria"`
}

type storedPreferredTool struct {
	NodeName string `json:"node_name"`
	Ordinal  int32  `json:"ordinal"`
	ToolName string `json:"tool_name"`
}

type storedPreferredSkill struct {
	NodeName  string `json:"node_name"`
	Ordinal   int32  `json:"ordinal"`
	SkillName string `json:"skill_name"`
}

type storedEdge struct {
	SourceNodeName   string `json:"source_node_name"`
	TargetNodeName   string `json:"target_node_name"`
	Ordinal          int32  `json:"ordinal"`
	BranchLabel      string `json:"branch_label"`
	ConditionSummary string `json:"condition_summary"`
}

type storedInputContract struct {
	Inputs        *gatewayapi.WorkflowInputs        `json:"inputs,omitempty"`
	ArbitraryJSON *gatewayapi.WorkflowArbitraryJSON `json:"arbitrary_json,omitempty"`
}

// ListSummaries returns workflow metadata for one agent without loading nodes or edges.
func ListSummaries(ctx context.Context, pool *pgxpool.Pool, tenantNamespace string, agtName string) ([]gatewayapi.WorkflowSummary, error) {
	rows, err := workflowdb.New(pool).WorkflowListSummaries(ctx, workflowdb.WorkflowListSummariesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
	})
	if err != nil {
		return nil, fmt.Errorf("list workflow summaries: %w", err)
	}

	summaries := make([]gatewayapi.WorkflowSummary, 0, len(rows))
	for _, row := range rows {
		summaries = append(summaries, gatewayapi.WorkflowSummary{
			WorkflowName: row.WorkflowName,
			Title:        row.Title,
			Summary:      row.Summary,
			UpdatedAt:    row.UpdatedAt,
		})
	}

	return summaries, nil
}

// Create stores a workflow and its graph.
func Create(ctx context.Context, pool *pgxpool.Pool, tenantNamespace string, agtName string, req gatewayapi.CreateWorkflowRequest) (workflowdb.Workflow, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	queries := workflowdb.New(tx)
	inputsJSON, err := inputContractJSON(req.Inputs, req.ArbitraryJson)
	if err != nil {
		return workflowdb.Workflow{}, err
	}

	row, err := queries.WorkflowCreate(ctx, workflowdb.WorkflowCreateParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    req.WorkflowName,
		Title:           req.Title,
		Summary:         req.Summary,
		InputSchema:     inputsJSON,
	})
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("create workflow: %w", err)
	}

	nodesJSON, preferredToolsJSON, preferredSkillsJSON, err := marshalNodes(req.Nodes)
	if err != nil {
		return workflowdb.Workflow{}, err
	}

	err = queries.WorkflowCreateNodes(ctx, workflowdb.WorkflowCreateNodesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    req.WorkflowName,
		Nodes:           nodesJSON,
	})
	if err != nil {
		return workflowdb.Workflow{}, fmt.Errorf("create workflow nodes: %w", err)
	}

	if len(preferredToolsJSON) > 0 && string(preferredToolsJSON) != "[]" {
		err := queries.WorkflowCreatePreferredTools(ctx, workflowdb.WorkflowCreatePreferredToolsParams{
			TenantNamespace: tenantNamespace,
			AgentName:       agtName,
			WorkflowName:    req.WorkflowName,
			PreferredTools:  preferredToolsJSON,
		})
		if err != nil {
			return workflowdb.Workflow{}, fmt.Errorf("create preferred tools: %w", err)
		}
	}

	if len(preferredSkillsJSON) > 0 && string(preferredSkillsJSON) != "[]" {
		err := queries.WorkflowCreatePreferredSkills(ctx, workflowdb.WorkflowCreatePreferredSkillsParams{
			TenantNamespace: tenantNamespace,
			AgentName:       agtName,
			WorkflowName:    req.WorkflowName,
			PreferredSkills: preferredSkillsJSON,
		})
		if err != nil {
			return workflowdb.Workflow{}, fmt.Errorf("create preferred skills: %w", err)
		}
	}

	edgesJSON, err := marshalEdges(req.Edges)
	if err != nil {
		return workflowdb.Workflow{}, err
	}

	if len(req.Edges) > 0 {
		err := queries.WorkflowCreateEdges(ctx, workflowdb.WorkflowCreateEdgesParams{
			TenantNamespace: tenantNamespace,
			AgentName:       agtName,
			WorkflowName:    req.WorkflowName,
			Edges:           edgesJSON,
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

// DeleteMany removes multiple workflows for one agent.
func DeleteMany(ctx context.Context, pool *pgxpool.Pool, k8sClient ctrlclient.Client, tenantNamespace string, agtName string, wfNames []string) ([]string, error) {
	names := uniqueNames(wfNames)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	queries := workflowdb.New(tx)
	existing, err := queries.WorkflowListExistingNames(ctx, workflowdb.WorkflowListExistingNamesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowNames:   names,
	})
	if err != nil {
		return nil, fmt.Errorf("list existing workflows: %w", err)
	}

	if len(existing) != len(names) {
		existingSet := make(map[string]struct{}, len(existing))
		for _, name := range existing {
			existingSet[name] = struct{}{}
		}

		missing := make([]string, 0, len(names)-len(existing))
		for _, name := range names {
			if _, ok := existingSet[name]; ok {
				continue
			}
			missing = append(missing, name)
		}
		return missing, ErrWorkflowNotFound
	}

	wfSet := make(map[string]struct{}, len(names))
	for _, name := range names {
		wfSet[name] = struct{}{}
	}

	runList := &agentzv1alpha1.WorkflowRunList{}
	err = k8sClient.List(ctx, runList, ctrlclient.InNamespace(tenantNamespace))
	if err != nil {
		return nil, fmt.Errorf("list workflow runs: %w", err)
	}
	for i := range runList.Items {
		run := &runList.Items[i]
		if run.Spec.AgentName != agtName {
			continue
		}
		if _, ok := wfSet[run.Spec.WorkflowName]; !ok {
			continue
		}
		err := k8sClient.Delete(ctx, run)
		if err != nil && !apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("delete workflow run %q: %w", run.Name, err)
		}
	}

	scheduleList := &agentzv1alpha1.WorkflowScheduleList{}
	err = k8sClient.List(ctx, scheduleList, ctrlclient.InNamespace(tenantNamespace))
	if err != nil {
		return nil, fmt.Errorf("list workflow schedules: %w", err)
	}
	for i := range scheduleList.Items {
		schedule := &scheduleList.Items[i]
		if schedule.Spec.AgentName != agtName {
			continue
		}
		if _, ok := wfSet[schedule.Spec.WorkflowName]; !ok {
			continue
		}
		err := k8sClient.Delete(ctx, schedule)
		if err != nil && !apierrors.IsNotFound(err) {
			return nil, fmt.Errorf(
				"delete workflow schedule %q: %w",
				schedule.Name,
				err,
			)
		}
	}

	_, err = queries.WorkflowDeleteMany(ctx, workflowdb.WorkflowDeleteManyParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowNames:   names,
	})
	if err != nil {
		return nil, fmt.Errorf("delete workflows: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return nil, nil
}

// Get reconstructs a stored workflow graph from normalized workflow tables.
func Get(ctx context.Context, pool *pgxpool.Pool, tenantNamespace string, agtName string, wfName string) (gatewayapi.Workflow, error) {
	queries := workflowdb.New(pool)

	row, err := queries.WorkflowGet(ctx, workflowdb.WorkflowGetParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    wfName,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gatewayapi.Workflow{}, ErrWorkflowNotFound
		}
		return gatewayapi.Workflow{}, fmt.Errorf("get workflow: %w", err)
	}

	nodeRows, err := queries.WorkflowListNodes(ctx, workflowdb.WorkflowListNodesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    wfName,
	})
	if err != nil {
		return gatewayapi.Workflow{}, fmt.Errorf("list workflow nodes: %w", err)
	}

	toolRows, err := queries.WorkflowListPreferredTools(ctx, workflowdb.WorkflowListPreferredToolsParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    wfName,
	})
	if err != nil {
		return gatewayapi.Workflow{}, fmt.Errorf("list preferred tools: %w", err)
	}

	skillRows, err := queries.WorkflowListPreferredSkills(ctx, workflowdb.WorkflowListPreferredSkillsParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    wfName,
	})
	if err != nil {
		return gatewayapi.Workflow{}, fmt.Errorf("list preferred skills: %w", err)
	}

	edgeRows, err := queries.WorkflowListEdges(ctx, workflowdb.WorkflowListEdgesParams{
		TenantNamespace: tenantNamespace,
		AgentName:       agtName,
		WorkflowName:    wfName,
	})
	if err != nil {
		return gatewayapi.Workflow{}, fmt.Errorf("list workflow edges: %w", err)
	}

	preferredToolsByNode := map[string][]string{}
	for _, toolRow := range toolRows {
		preferredToolsByNode[toolRow.NodeName] = append(
			preferredToolsByNode[toolRow.NodeName],
			toolRow.ToolName,
		)
	}

	preferredSkillsByNode := map[string][]string{}
	for _, skillRow := range skillRows {
		preferredSkillsByNode[skillRow.NodeName] = append(
			preferredSkillsByNode[skillRow.NodeName],
			skillRow.SkillName,
		)
	}

	nodes := make([]gatewayapi.WorkflowNode, 0, len(nodeRows))
	for _, nodeRow := range nodeRows {
		var preferredTools *[]string
		if toolNames := preferredToolsByNode[nodeRow.NodeName]; toolNames != nil {
			clonedToolNames := slices.Clone(toolNames)
			preferredTools = &clonedToolNames
		}

		var preferredSkills *[]string
		if skillNames := preferredSkillsByNode[nodeRow.NodeName]; skillNames != nil {
			clonedSkillNames := slices.Clone(skillNames)
			preferredSkills = &clonedSkillNames
		}

		nodes = append(nodes, gatewayapi.WorkflowNode{
			Name:            nodeRow.NodeName,
			Instructions:    nodeRow.Instructions,
			Goal:            nodeRow.Goal,
			DoneCriteria:    nodeRow.DoneCriteria,
			PreferredSkills: preferredSkills,
			PreferredTools:  preferredTools,
		})
	}

	edges := make([]gatewayapi.WorkflowEdge, 0, len(edgeRows))
	for _, edgeRow := range edgeRows {
		edges = append(edges, gatewayapi.WorkflowEdge{
			Source:           edgeRow.SourceNodeName,
			Target:           edgeRow.TargetNodeName,
			BranchLabel:      edgeRow.BranchLabel,
			ConditionSummary: edgeRow.ConditionSummary,
		})
	}

	var inputs *gatewayapi.WorkflowInputs
	var arbitraryJSON *gatewayapi.WorkflowArbitraryJSON
	if row.InputSchema != nil {
		var err error
		inputs, arbitraryJSON, err = decodeInputContract(row.InputSchema)
		if err != nil {
			return gatewayapi.Workflow{}, err
		}
	}

	return gatewayapi.Workflow{
		AgentName:     row.AgentName,
		WorkflowName:  row.WorkflowName,
		Title:         row.Title,
		Summary:       row.Summary,
		Inputs:        inputs,
		ArbitraryJson: arbitraryJSON,
		Nodes:         nodes,
		Edges:         edges,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}, nil
}

func marshalNodes(nodes []gatewayapi.WorkflowNode) ([]byte, []byte, []byte, error) {
	storedNodes := make([]storedNode, 0, len(nodes))
	preferredTools := make([]storedPreferredTool, 0)
	preferredSkills := make([]storedPreferredSkill, 0)

	for nodeIndex, node := range nodes {
		storedNodes = append(storedNodes, storedNode{
			NodeName:     node.Name,
			Ordinal:      int32(nodeIndex),
			Instructions: node.Instructions,
			Goal:         node.Goal,
			DoneCriteria: node.DoneCriteria,
		})

		if node.PreferredTools != nil {
			for toolIndex, toolName := range *node.PreferredTools {
				preferredTools = append(preferredTools, storedPreferredTool{
					NodeName: node.Name,
					Ordinal:  int32(toolIndex),
					ToolName: toolName,
				})
			}
		}

		if node.PreferredSkills != nil {
			for skillIndex, skillName := range *node.PreferredSkills {
				preferredSkills = append(preferredSkills, storedPreferredSkill{
					NodeName:  node.Name,
					Ordinal:   int32(skillIndex),
					SkillName: skillName,
				})
			}
		}
	}

	nodesJSON, err := json.Marshal(storedNodes)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("marshal workflow nodes: %w", err)
	}

	preferredToolsJSON, err := json.Marshal(preferredTools)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("marshal preferred tools: %w", err)
	}

	preferredSkillsJSON, err := json.Marshal(preferredSkills)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("marshal preferred skills: %w", err)
	}

	return nodesJSON, preferredToolsJSON, preferredSkillsJSON, nil
}

func marshalEdges(edges []gatewayapi.WorkflowEdge) ([]byte, error) {
	storedEdges := make([]storedEdge, 0, len(edges))

	for edgeIndex, edge := range edges {
		storedEdges = append(storedEdges, storedEdge{
			SourceNodeName:   edge.Source,
			TargetNodeName:   edge.Target,
			Ordinal:          int32(edgeIndex),
			BranchLabel:      edge.BranchLabel,
			ConditionSummary: edge.ConditionSummary,
		})
	}

	edgesJSON, err := json.Marshal(storedEdges)
	if err != nil {
		return nil, fmt.Errorf("marshal workflow edges: %w", err)
	}

	return edgesJSON, nil
}

func inputContractJSON(inputs *gatewayapi.WorkflowInputs, arbitraryJSON *gatewayapi.WorkflowArbitraryJSON) ([]byte, error) {
	if inputs == nil && arbitraryJSON == nil {
		return nil, nil
	}

	raw, err := json.Marshal(storedInputContract{
		Inputs:        inputs,
		ArbitraryJSON: arbitraryJSON,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal workflow input contract: %w", err)
	}
	return raw, nil
}

func decodeInputContract(raw []byte) (*gatewayapi.WorkflowInputs, *gatewayapi.WorkflowArbitraryJSON, error) {
	var decoded storedInputContract
	err := json.Unmarshal(raw, &decoded)
	if err != nil {
		return nil, nil, fmt.Errorf("unmarshal workflow input contract: %w", err)
	}
	return decoded.Inputs, decoded.ArbitraryJSON, nil
}

func uniqueNames(names []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(names))

	for _, name := range names {
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}

	return out
}
