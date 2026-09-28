package gateway

import (
	"math"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type evaluationScoreCase struct {
	name                    string
	correctness, efficiency int
	status                  gatewayapi.WorkflowRunStatus
	missing                 bool
	want                    float64
}

// TestEvaluationScore checks quality gates and missing measurements.
func TestEvaluationScore(t *testing.T) {
	tests := []evaluationScoreCase{
		{name: "complete efficient solo execution", correctness: 4, efficiency: 4, status: gatewayapi.WorkflowRunStatusSucceeded, want: 95},
		{name: "minor issues", correctness: 3, efficiency: 4, status: gatewayapi.WorkflowRunStatusSucceeded, want: 71.25},
		{name: "partial work fails quality gate", correctness: 2, efficiency: 4, status: gatewayapi.WorkflowRunStatusSucceeded, want: 0},
		{name: "failed execution cannot pass", correctness: 4, efficiency: 4, status: gatewayapi.WorkflowRunStatusFailed, want: 0},
		{name: "unavailable usage is unscored", correctness: 4, efficiency: 4, status: gatewayapi.WorkflowRunStatusSucceeded, missing: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			execution := gatewayapi.EvaluationExecution{
				State: gatewayapi.EvaluationExecutionStateCompleted, RunStatus: &tt.status,
				Tokens: new(100.0), ToolCalls: new(0), DurationSeconds: new(10.0),
				Judgment: &gatewayapi.EvaluationJudgment{Correctness: tt.correctness, Efficiency: tt.efficiency},
			}
			if tt.missing {
				execution.Tokens = nil
			}
			evaluation := gatewayapi.WorkflowEvaluation{Executions: []gatewayapi.EvaluationExecution{execution}}
			scoreEvaluation(&evaluation)
			result := evaluation.Executions[0]
			if tt.missing {
				if result.Score != nil {
					t.Fatal("missing usage received a score")
				}
				return
			}
			if result.Score == nil || math.Abs(*result.Score-tt.want) > 1e-8 {
				t.Fatalf("score = %v, want %v", result.Score, tt.want)
			}
		})
	}
}

// TestEvaluationReferencesFreezeBeforeJudgment keeps judge retries comparable.
func TestEvaluationReferencesFreezeBeforeJudgment(t *testing.T) {
	evaluation := gatewayapi.WorkflowEvaluation{}
	for _, tokens := range []float64{100, 200, 300, 10000} {
		evaluation.Executions = append(evaluation.Executions, gatewayapi.EvaluationExecution{
			State:     gatewayapi.EvaluationExecutionStateJudging,
			RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded),
			Tokens:    &tokens, ToolCalls: new(4), DurationSeconds: new(20.0),
		})
	}
	scoreEvaluation(&evaluation)
	if evaluation.References == nil || evaluation.References.Tokens != 250 {
		t.Fatalf("references = %+v", evaluation.References)
	}
	for i := range evaluation.Executions {
		if evaluation.Executions[i].Score != nil {
			t.Fatal("execution received score without judgment")
		}
		evaluation.Executions[i].Judgment = &gatewayapi.EvaluationJudgment{Correctness: 4, Efficiency: 4}
	}
	scoreEvaluation(&evaluation)
	if *evaluation.Executions[0].Score <= *evaluation.Executions[3].Score {
		t.Fatal("lower resource use should win at equal quality")
	}
	evaluation.Executions[0].Judgment.Correctness = 0
	scoreEvaluation(&evaluation)
	if evaluation.References.Tokens != 250 {
		t.Fatal("judge retry changed reference cohort")
	}
	if *evaluation.Executions[0].Score != 0 {
		t.Fatal("correctness gate not applied on retry")
	}
}

// TestEvaluationReferencesWaitForExecution prevents partial cohort scoring.
func TestEvaluationReferencesWaitForExecution(t *testing.T) {
	evaluation := gatewayapi.WorkflowEvaluation{Executions: []gatewayapi.EvaluationExecution{
		{State: gatewayapi.EvaluationExecutionStateJudging, RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded), Tokens: new(100.0), ToolCalls: new(2), DurationSeconds: new(10.0)},
		{State: gatewayapi.EvaluationExecutionStateRunning},
	}}
	scoreEvaluation(&evaluation)
	if evaluation.References != nil {
		t.Fatal("references froze while cohort was running")
	}
}
