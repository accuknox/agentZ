package gateway

import (
	"fmt"
	"math"
	"testing"

	"github.com/google/uuid"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
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
		{
			name:        "complete efficient solo execution",
			correctness: 4,
			efficiency:  4,
			status:      gatewayapi.WorkflowRunStatusSucceeded,
			want:        95,
		},
		{
			name:        "minor issues",
			correctness: 3,
			efficiency:  4,
			status:      gatewayapi.WorkflowRunStatusSucceeded,
			want:        71.25,
		},
		{
			name:        "partial work fails quality gate",
			correctness: 2,
			efficiency:  4,
			status:      gatewayapi.WorkflowRunStatusSucceeded,
			want:        0,
		},
		{
			name:        "failed execution cannot pass",
			correctness: 4,
			efficiency:  4,
			status:      gatewayapi.WorkflowRunStatusFailed,
			want:        0,
		},
		{
			name:        "unavailable usage is unscored",
			correctness: 4,
			efficiency:  4,
			status:      gatewayapi.WorkflowRunStatusSucceeded,
			missing:     true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			execution := gatewayapi.EvaluationExecution{
				State:     gatewayapi.EvaluationExecutionStateCompleted,
				RunStatus: &tt.status,
				Tokens:    new(100.0),
				ToolCalls: new(0),
				Judgment: &gatewayapi.EvaluationJudgment{
					Correctness: tt.correctness,
					Efficiency:  tt.efficiency,
				},
			}
			if tt.missing {
				execution.Tokens = nil
			}
			evaluation := gatewayapi.WorkflowEvaluation{
				Executions: []gatewayapi.EvaluationExecution{execution},
			}
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
	tokenCounts := []float64{100, 200, 300, 10000}
	for _, tokens := range tokenCounts {
		evaluation.Executions = append(evaluation.Executions, gatewayapi.EvaluationExecution{
			State:     gatewayapi.EvaluationExecutionStateJudging,
			RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded),
			Tokens:    &tokens,
			ToolCalls: new(4),
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
	evaluation := gatewayapi.WorkflowEvaluation{
		Executions: []gatewayapi.EvaluationExecution{
			{
				State:     gatewayapi.EvaluationExecutionStateJudging,
				RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded),
				Tokens:    new(100.0),
				ToolCalls: new(2),
			},
			{State: gatewayapi.EvaluationExecutionStateRunning},
		},
	}
	scoreEvaluation(&evaluation)
	if evaluation.References != nil {
		t.Fatal("references froze while cohort was running")
	}
}

// TestEvaluationScoreIgnoresDuration keeps infrastructure speed out of scoring.
func TestEvaluationScoreIgnoresDuration(t *testing.T) {
	durations := []*float64{nil, new(0.0), new(900.0), new(math.NaN())}
	for _, duration := range durations {
		evaluation := gatewayapi.WorkflowEvaluation{
			Executions: []gatewayapi.EvaluationExecution{{
				State:           gatewayapi.EvaluationExecutionStateCompleted,
				RunStatus:       new(gatewayapi.WorkflowRunStatusSucceeded),
				Tokens:          new(100.0),
				ToolCalls:       new(4),
				DurationSeconds: duration,
				Judgment:        &gatewayapi.EvaluationJudgment{Correctness: 4, Efficiency: 4},
			}},
		}
		scoreEvaluation(&evaluation)
		if evaluation.Executions[0].Score == nil || *evaluation.Executions[0].Score != 95 {
			t.Fatalf("duration %v changed scoring: %+v", duration, evaluation.Executions[0])
		}
	}
}

// TestEvaluationParallelRuns checks admission, recovery, slot refill and cancellation.
func TestEvaluationParallelRuns(t *testing.T) {
	concurrencyLevels := []int{1, 3, 5}
	for _, concurrency := range concurrencyLevels {
		t.Run(fmt.Sprint(concurrency), func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			k8s := fake.NewClientBuilder().WithScheme(scheme).Build()
			service := &Service{k8sClient: k8s}
			job := workflowdb.WorkflowRunEvaluation{
				TenantNamespace: "test",
				AgentName:       "agent",
				WorkflowName:    "workflow",
			}
			evaluation := gatewayapi.WorkflowEvaluation{
				Id: uuid.New(),
				Request: gatewayapi.WorkflowEvaluationRequest{
					Concurrency:    concurrency,
					TimeoutSeconds: 37,
				},
			}
			for i := range 8 {
				evaluation.Executions = append(evaluation.Executions, gatewayapi.EvaluationExecution{
					RunName: fmt.Sprintf("eval-%s-%d", evaluation.Id, i),
					State:   gatewayapi.EvaluationExecutionStateQueued,
					Model:   gatewayapi.EvaluationModel{ProviderId: "provider", ModelId: fmt.Sprint(i)},
				})
			}
			ctx := t.Context()
			for attempt := range 3 {
				if err := service.advanceEvaluationRuns(ctx, job, &evaluation); err != nil {
					t.Fatal(err)
				}
				var runs agentzv1alpha1.WorkflowRunList
				if err := k8s.List(ctx, &runs); err != nil {
					t.Fatal(err)
				}
				if len(runs.Items) != concurrency {
					t.Fatalf("attempt %d: created %d runs, limit %d", attempt, len(runs.Items), concurrency)
				}
				for _, run := range runs.Items {
					if run.Spec.TimeoutSeconds != 37 || run.Spec.Definition == nil || run.Spec.Model == nil {
						t.Fatalf("run settings not preserved: %+v", run.Spec)
					}
				}
				// Recover a claim whose Kubernetes writes succeeded before its database save.
				if attempt == 0 {
					for i := range evaluation.Executions {
						evaluation.Executions[i].State = gatewayapi.EvaluationExecutionStateQueued
					}
				}
			}
			// Judging keeps the slot across worker steps, including recovery.
			for i := range concurrency {
				evaluation.Executions[i].State = gatewayapi.EvaluationExecutionStateJudging
			}
			for range 2 {
				if err := service.advanceEvaluationRuns(ctx, job, &evaluation); err != nil {
					t.Fatal(err)
				}
				var runs agentzv1alpha1.WorkflowRunList
				if err := k8s.List(ctx, &runs); err != nil {
					t.Fatal(err)
				}
				if len(runs.Items) != concurrency {
					t.Fatal("a run started before judging released its slot")
				}
			}
			for i := range concurrency {
				evaluation.Executions[i].State = gatewayapi.EvaluationExecutionStateRunning
			}
			// Losing a later run must release its slot even while the first run is active.
			var finished agentzv1alpha1.WorkflowRun
			key := client.ObjectKey{
				Namespace: "test",
				Name:      evaluation.Executions[concurrency-1].RunName,
			}
			if err := k8s.Get(ctx, key, &finished); err != nil {
				t.Fatal(err)
			}
			if err := k8s.Delete(ctx, &finished); err != nil {
				t.Fatal(err)
			}
			if err := service.advanceEvaluationRuns(ctx, job, &evaluation); err != nil {
				t.Fatal(err)
			}
			if evaluation.Executions[concurrency-1].State != gatewayapi.EvaluationExecutionStateError {
				t.Fatal("missing run did not finish")
			}
			if evaluation.Executions[concurrency].State != gatewayapi.EvaluationExecutionStateRunning {
				t.Fatal("available slot was not filled")
			}
			// Cancellation must also discover runs whose admission was not saved.
			evaluation.Executions[concurrency].State = gatewayapi.EvaluationExecutionStateQueued
			for range 2 {
				if err := service.cancelEvaluation(ctx, job, &evaluation); err != nil {
					t.Fatal(err)
				}
			}
			var remaining agentzv1alpha1.WorkflowRunList
			if err := k8s.List(ctx, &remaining); err != nil {
				t.Fatal(err)
			}
			if len(remaining.Items) != 0 || evaluation.State != gatewayapi.WorkflowEvaluationStateCancelled {
				t.Fatal("cancellation left admitted runs behind")
			}
		})
	}
}

// TestEvaluationDeletion waits for finalizers on all owned runs, including runs
// whose completion or creation was never saved by the evaluation worker.
func TestEvaluationDeletion(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	k8s := fake.NewClientBuilder().WithScheme(scheme).Build()
	service := &Service{k8sClient: k8s}
	job := workflowdb.WorkflowRunEvaluation{
		ID:              uuid.New(),
		TenantNamespace: "test",
		AgentName:       "agent",
		WorkflowName:    "workflow",
	}
	names := []string{"running", "completed", "unrelated"}
	for _, name := range names {
		id := job.ID.String()
		if name == "unrelated" {
			id = uuid.NewString()
		}
		run := &agentzv1alpha1.WorkflowRun{
			ObjectMeta: metav1.ObjectMeta{
				Namespace:  "test",
				Name:       name,
				Labels:     map[string]string{"agentz.accuknox.com/evaluation": id},
				Finalizers: []string{"test/session-cleanup"},
			},
			Spec: agentzv1alpha1.WorkflowRunSpec{
				AgentName:    "agent",
				WorkflowName: "workflow",
			},
		}
		if name == "completed" {
			run.Status.Phase = agentzv1alpha1.WorkflowRunPhaseSucceeded
		}
		if err := k8s.Create(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := service.deleteEvaluation(t.Context(), job); err != nil {
			t.Fatal(err)
		}
		var runs agentzv1alpha1.WorkflowRunList
		if err := k8s.List(t.Context(), &runs); err != nil {
			t.Fatal(err)
		}
		for _, run := range runs.Items {
			deleting := !run.DeletionTimestamp.IsZero()
			if deleting != (run.Name != "unrelated") {
				t.Fatalf("run %s: deleting = %v", run.Name, deleting)
			}
		}
	}
	job.WorkflowName = "other-workflow"
	if err := service.deleteEvaluation(t.Context(), job); err == nil {
		t.Fatal("cleanup accepted runs belonging to another workflow")
	}
}
