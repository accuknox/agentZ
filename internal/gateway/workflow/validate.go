package workflow

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/accuknox/clawarmor/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/clawarmor/internal/gateway/openapi"
	"github.com/accuknox/clawarmor/internal/workflow"
)

func ValidateLookupRequest(agentName string, workflowName string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, 2)

	if !isDNSLabel(agentName, 32) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "agentName",
			Message: "must be a valid DNS label",
		})
	}
	if !isDNSLabel(workflowName, 32) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "workflowName",
			Message: "must be a valid DNS label",
		})
	}

	return fields
}

func ValidateListRequest(agentName string) []gatewayapi.FieldError {
	if isDNSLabel(agentName, 32) {
		return nil
	}

	return []gatewayapi.FieldError{{
		Field:   "agentName",
		Message: "must be a valid DNS label",
	}}
}

// ValidateDeleteRequest validates one agent-scoped workflow delete request.
func ValidateDeleteRequest(agentName string, workflowNames []string) []gatewayapi.FieldError {
	fields := make([]gatewayapi.FieldError, 0, len(workflowNames)+1)

	if !isDNSLabel(agentName, 32) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "agentName",
			Message: "must be a valid DNS label",
		})
	}

	if len(workflowNames) == 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "workflow_names",
			Message: "must include at least one workflow name",
		})
		return fields
	}

	for i, workflowName := range workflowNames {
		if isDNSLabel(workflowName, 32) {
			continue
		}

		fields = append(fields, gatewayapi.FieldError{
			Field:   fmt.Sprintf("workflow_names.%d", i),
			Message: "must be a valid DNS label",
		})
	}

	return fields
}

//nolint:gocyclo
func ValidateCreateRequest(req gatewayapi.CreateWorkflowRequest) ([]gatewayapi.FieldError, error) {
	fields := make([]gatewayapi.FieldError, 0)

	if !isDNSLabel(req.AgentName, 32) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "agent_name",
			Message: "must be a valid DNS label",
		})
	}
	if !isDNSLabel(req.WorkflowName, 32) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "workflow_name",
			Message: "must be a valid DNS label",
		})
	}
	if strings.TrimSpace(req.Title) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "title",
			Message: "required",
		})
	}
	if strings.TrimSpace(req.Summary) == "" {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "summary",
			Message: "required",
		})
	}
	inputIssues, err := workflow.ValidateDefinition(req.Inputs, "inputs")
	if err != nil {
		return nil, err
	}
	for _, issue := range inputIssues {
		fields = append(fields, gatewayapi.FieldError{
			Field:   issue.Field,
			Message: issue.Message,
		})
	}
	if len(req.Nodes) == 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "nodes",
			Message: "must include at least one node",
		})
		return fields, nil
	}

	nodeIndex := make(map[string]int, len(req.Nodes))
	inDegree := make(map[string]int, len(req.Nodes))
	outDegree := make(map[string]int, len(req.Nodes))
	undirected := make(map[string][]string, len(req.Nodes))
	adjacency := make(map[string][]string, len(req.Nodes))

	for nodeIndexValue, node := range req.Nodes {
		name := node.Name
		fieldPrefix := "nodes." + strconv.Itoa(nodeIndexValue)
		if !isDNSLabel(name, 64) {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".name",
				Message: "must be a valid DNS label",
			})
			continue
		}
		if _, exists := nodeIndex[name]; exists {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".name",
				Message: "must be unique",
			})
			continue
		}

		nodeIndex[name] = nodeIndexValue
		inDegree[name] = 0
		outDegree[name] = 0
		adjacency[name] = []string{}
		undirected[name] = []string{}

		if strings.TrimSpace(node.Instructions) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".instructions",
				Message: "required",
			})
		}
		if strings.TrimSpace(node.Goal) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".goal",
				Message: "required",
			})
		}
		if strings.TrimSpace(node.DoneCriteria) == "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".done_criteria",
				Message: "required",
			})
		}

		seenTools := make(map[string]struct{}, len(node.PreferredTools))
		for toolIndex, tool := range node.PreferredTools {
			field := fieldPrefix + ".preferred_tools." + strconv.Itoa(toolIndex)
			if tool == "" {
				fields = append(fields, gatewayapi.FieldError{
					Field:   field,
					Message: "must not be empty",
				})
				continue
			}
			if _, exists := seenTools[tool]; exists {
				fields = append(fields, gatewayapi.FieldError{
					Field:   field,
					Message: "must be unique within the node",
				})
				continue
			}
			seenTools[tool] = struct{}{}
		}
	}

	for edgeIndex, edge := range req.Edges {
		fieldPrefix := "edges." + strconv.Itoa(edgeIndex)
		source := edge.Source
		target := edge.Target

		if _, exists := nodeIndex[source]; !exists {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".source",
				Message: "must reference an existing node",
			})
		}
		if _, exists := nodeIndex[target]; !exists {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".target",
				Message: "must reference an existing node",
			})
		}
		if source == target && source != "" {
			fields = append(fields, gatewayapi.FieldError{
				Field:   fieldPrefix + ".target",
				Message: "must not create a self-loop",
			})
		}

		if _, sourceExists := nodeIndex[source]; sourceExists {
			adjacency[source] = append(adjacency[source], target)
			outDegree[source]++
		}
		if _, targetExists := nodeIndex[target]; targetExists {
			inDegree[target]++
		}
		if _, sourceExists := nodeIndex[source]; sourceExists {
			if _, targetExists := nodeIndex[target]; targetExists {
				undirected[source] = append(undirected[source], target)
				undirected[target] = append(undirected[target], source)
			}
		}
	}

	if len(fields) > 0 {
		return fields, nil
	}

	if hasCycle(adjacency, inDegree) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "edges",
			Message: "must form an acyclic graph",
		})
	}
	if !isWeaklyConnected(undirected, req.Nodes[0].Name) {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "nodes",
			Message: "must form one connected graph",
		})
	}
	if countTerminalNodes(inDegree) == 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "nodes",
			Message: "must include at least one start node",
		})
	}
	if countTerminalNodes(outDegree) == 0 {
		fields = append(fields, gatewayapi.FieldError{
			Field:   "nodes",
			Message: "must include at least one terminal node",
		})
	}

	fields = append(fields, validateBranchConditions(req, outDegree)...)

	return fields, nil
}

func isDNSLabel(value string, maxLen int) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= maxLen && len(validation.IsDNS1123Label(value)) == 0
}

func hasCycle(adjacency map[string][]string, inDegree map[string]int) bool {
	remaining := make(map[string]int, len(inDegree))
	queue := make([]string, 0, len(inDegree))

	for nodeName, degree := range inDegree {
		remaining[nodeName] = degree
		if degree == 0 {
			queue = append(queue, nodeName)
		}
	}

	visited := 0
	for len(queue) > 0 {
		nodeName := queue[0]
		queue = queue[1:]
		visited++

		for _, nextNode := range adjacency[nodeName] {
			remaining[nextNode]--
			if remaining[nextNode] == 0 {
				queue = append(queue, nextNode)
			}
		}
	}

	return visited != len(inDegree)
}

func isWeaklyConnected(undirected map[string][]string, start string) bool {
	if start == "" {
		return false
	}

	visited := map[string]struct{}{start: {}}
	queue := []string{start}

	for len(queue) > 0 {
		nodeName := queue[0]
		queue = queue[1:]

		for _, nextNode := range undirected[nodeName] {
			if _, seen := visited[nextNode]; seen {
				continue
			}
			visited[nextNode] = struct{}{}
			queue = append(queue, nextNode)
		}
	}

	return len(visited) == len(undirected)
}

func countTerminalNodes(degrees map[string]int) int {
	count := 0
	for _, degree := range degrees {
		if degree == 0 {
			count++
		}
	}
	return count
}

func validateBranchConditions(req gatewayapi.CreateWorkflowRequest, outDegree map[string]int) []gatewayapi.FieldError {
	fields := []gatewayapi.FieldError{}
	for edgeIndex, edge := range req.Edges {
		if outDegree[edge.Source] <= 1 {
			continue
		}
		if strings.TrimSpace(edge.ConditionSummary) != "" {
			continue
		}

		fields = append(fields, gatewayapi.FieldError{
			Field:   "edges." + strconv.Itoa(edgeIndex) + ".condition_summary",
			Message: "required when the source node has multiple outgoing edges",
		})
	}

	return fields
}

// MapCreateError translates workflow persistence and validation setup errors to API errors.
func MapCreateError(err error) *apiutil.APIError {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "23503":
			return apiutil.NewError(404, "not_found", "agent not found", err)
		case "23505":
			field := "workflow_name"
			if strings.Contains(pgErr.ConstraintName, "workflow_nodes_pkey") {
				field = "nodes"
			}
			return apiutil.NewError(
				409,
				"conflict",
				"request conflicts with existing data",
				err,
				gatewayapi.FieldError{Field: field, Message: "already in-use"},
			)
		}
	}

	return apiutil.NewError(500, "internal_error", "request failed", err)
}

// MapDeleteError translates workflow delete errors to API errors.
func MapDeleteError(err error, missing []string) *apiutil.APIError {
	if errors.Is(err, ErrWorkflowNotFound) {
		fields := make([]gatewayapi.FieldError, 0, len(missing))
		for _, name := range missing {
			fields = append(fields, gatewayapi.FieldError{
				Field:   "workflow_names",
				Message: fmt.Sprintf("workflow %q was not found", name),
			})
		}

		return apiutil.NewError(
			404,
			"not_found",
			"one or more workflows were not found",
			err,
			fields...,
		)
	}

	return apiutil.NewError(
		500,
		"internal_error",
		"request failed",
		err,
	)
}

// MapGetError translates workflow read failures to API errors.
func MapGetError(err error) *apiutil.APIError {
	if errors.Is(err, ErrWorkflowNotFound) {
		return apiutil.NewError(404, "not_found", "workflow not found", err)
	}

	return apiutil.NewError(500, "internal_error", "request failed", err)
}
