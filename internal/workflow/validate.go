package workflow

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/google/cel-go/cel"
	"k8s.io/apimachinery/pkg/util/validation"

	workflowapi "github.com/accuknox/clawarmor/internal/workflow/openapi"
)

var (
	errConditionEnvUnavailable = errors.New("condition environment unavailable")
	conditionEnvOnce           sync.Once
	conditionEnv               *cel.Env
	conditionEnvErr            error
)

//nolint:gocyclo
func validateCreateWorkflowRequest(req workflowapi.CreateWorkflowRequest) ([]workflowapi.FieldError, error) {
	fields := []workflowapi.FieldError{}

	if !isDNSLabel(req.AgentName, 32) {
		fields = append(fields, workflowapi.FieldError{
			Field:   "agent_name",
			Message: "must be a valid DNS label",
		})
	}
	if !isDNSLabel(req.WorkflowName, 32) {
		fields = append(fields, workflowapi.FieldError{
			Field:   "workflow_name",
			Message: "must be a valid DNS label",
		})
	}
	if strings.TrimSpace(req.Title) == "" {
		fields = append(fields, workflowapi.FieldError{Field: "title", Message: "required"})
	}
	if strings.TrimSpace(req.Summary) == "" {
		fields = append(fields, workflowapi.FieldError{Field: "summary", Message: "required"})
	}
	if len(req.Nodes) == 0 {
		fields = append(fields, workflowapi.FieldError{Field: "nodes", Message: "must include at least one node"})
		return fields, nil
	}

	nodeIndex := make(map[string]int, len(req.Nodes))
	inDegree := make(map[string]int, len(req.Nodes))
	outDegree := make(map[string]int, len(req.Nodes))
	undirected := make(map[string][]string, len(req.Nodes))
	adjacency := make(map[string][]string, len(req.Nodes))

	for idx, node := range req.Nodes {
		name := node.Name
		fieldPrefix := "nodes." + itoa(idx)
		if !isDNSLabel(name, 64) {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix + ".name",
				Message: "must be a valid DNS label",
			})
			continue
		}
		if _, exists := nodeIndex[name]; exists {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix + ".name",
				Message: "must be unique",
			})
			continue
		}
		nodeIndex[name] = idx
		inDegree[name] = 0
		outDegree[name] = 0
		adjacency[name] = []string{}
		undirected[name] = []string{}

		fields = append(fields, requiredTextField(fieldPrefix+".instructions", node.Instructions)...)
		fields = append(fields, requiredTextField(fieldPrefix+".goal", node.Goal)...)
		fields = append(fields, requiredTextField(fieldPrefix+".expected_output", node.ExpectedOutput)...)
		fields = append(fields, requiredTextField(fieldPrefix+".done_criteria", node.DoneCriteria)...)

		seenTools := map[string]struct{}{}
		for toolIdx, tool := range node.PreferredTools {
			trimmed := strings.TrimSpace(tool)
			field := fieldPrefix + ".preferred_tools." + itoa(toolIdx)
			if trimmed == "" {
				fields = append(fields, workflowapi.FieldError{Field: field, Message: "must not be empty"})
				continue
			}
			if _, exists := seenTools[trimmed]; exists {
				fields = append(fields, workflowapi.FieldError{Field: field, Message: "must be unique within the node"})
				continue
			}
			seenTools[trimmed] = struct{}{}
		}
	}

	for idx, edge := range req.Edges {
		fieldPrefix := "edges." + itoa(idx)
		source := edge.Source
		target := edge.Target
		if _, exists := nodeIndex[source]; !exists {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix + ".source",
				Message: "must reference an existing node",
			})
		}
		if _, exists := nodeIndex[target]; !exists {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix + ".target",
				Message: "must reference an existing node",
			})
		}
		if source == target && source != "" {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix + ".target",
				Message: "must not create a self-loop",
			})
		}

		summary := strings.TrimSpace(edge.ConditionSummary)
		expr := strings.TrimSpace(edge.CelExpression)
		if (summary == "") != (expr == "") {
			fields = append(fields, workflowapi.FieldError{
				Field:   fieldPrefix,
				Message: "condition_summary and cel_expression must be provided together",
			})
		}
		if expr != "" {
			env, err := workflowConditionEnv()
			if err != nil {
				return nil, err
			}
			ast, issues := env.Compile(expr)
			if issues != nil && issues.Err() != nil {
				fields = append(fields, workflowapi.FieldError{
					Field:   fieldPrefix + ".cel_expression",
					Message: issues.Err().Error(),
				})
			} else if ast != nil && ast.OutputType() != cel.BoolType && ast.OutputType() != cel.DynType {
				fields = append(fields, workflowapi.FieldError{
					Field:   fieldPrefix + ".cel_expression",
					Message: "must evaluate to a boolean",
				})
			}
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
		fields = append(fields, workflowapi.FieldError{
			Field:   "edges",
			Message: "must form an acyclic graph",
		})
	}
	if !isWeaklyConnected(undirected, req.Nodes[0].Name) {
		fields = append(fields, workflowapi.FieldError{
			Field:   "nodes",
			Message: "must form one connected graph",
		})
	}
	if countTerminalNodes(inDegree) == 0 {
		fields = append(fields, workflowapi.FieldError{
			Field:   "nodes",
			Message: "must include at least one start node",
		})
	}
	if countTerminalNodes(outDegree) == 0 {
		fields = append(fields, workflowapi.FieldError{
			Field:   "nodes",
			Message: "must include at least one terminal node",
		})
	}

	return fields, nil
}

func requiredTextField(field string, value string) []workflowapi.FieldError {
	if strings.TrimSpace(value) != "" {
		return nil
	}
	return []workflowapi.FieldError{{
		Field:   field,
		Message: "required",
	}}
}

func isDNSLabel(value string, maxLen int) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= maxLen && len(validation.IsDNS1123Label(value)) == 0
}

func hasCycle(adjacency map[string][]string, inDegree map[string]int) bool {
	remaining := make(map[string]int, len(inDegree))
	queue := make([]string, 0, len(inDegree))
	for node, degree := range inDegree {
		remaining[node] = degree
		if degree == 0 {
			queue = append(queue, node)
		}
	}

	visited := 0
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		visited++
		for _, next := range adjacency[node] {
			remaining[next]--
			if remaining[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	return visited != len(inDegree)
}

func isWeaklyConnected(undirected map[string][]string, start string) bool {
	visited := map[string]struct{}{}
	queue := []string{start}
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		if _, ok := visited[node]; ok {
			continue
		}
		visited[node] = struct{}{}
		for _, next := range undirected[node] {
			if _, ok := visited[next]; ok {
				continue
			}
			queue = append(queue, next)
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

func workflowConditionEnv() (*cel.Env, error) {
	conditionEnvOnce.Do(func() {
		conditionEnv, conditionEnvErr = cel.NewEnv(
			cel.Variable("input", cel.AnyType),
			cel.Variable("workflow", cel.AnyType),
			cel.Variable("steps", cel.AnyType),
			cel.Variable("vars", cel.AnyType),
		)
		if conditionEnvErr != nil {
			conditionEnvErr = fmt.Errorf("%w: %w", errConditionEnvUnavailable, conditionEnvErr)
		}
	})
	if conditionEnvErr != nil {
		return nil, conditionEnvErr
	}
	return conditionEnv, nil
}

func itoa(v int) string {
	return strconv.Itoa(v)
}
