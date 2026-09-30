package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/accuknox/agentz/internal/gateway/apiutil"
	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	workflowdb "github.com/accuknox/agentz/internal/gateway/workflow/db"
	agentzv1alpha1 "github.com/accuknox/agentz/pkg/apis/agentz/v1alpha1"
	listersv1alpha1 "github.com/accuknox/agentz/pkg/controller/listers/agentz/v1alpha1"
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
				Tokens: new(100.0), ToolCalls: new(0),
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
			Tokens:    &tokens, ToolCalls: new(4),
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
		{State: gatewayapi.EvaluationExecutionStateJudging, RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded), Tokens: new(100.0), ToolCalls: new(2)},
		{State: gatewayapi.EvaluationExecutionStateRunning},
	}}
	scoreEvaluation(&evaluation)
	if evaluation.References != nil {
		t.Fatal("references froze while cohort was running")
	}
}

// TestEvaluationScoreIgnoresDuration keeps infrastructure speed out of scoring.
func TestEvaluationScoreIgnoresDuration(t *testing.T) {
	for _, duration := range []*float64{nil, new(0.0), new(900.0), new(math.NaN())} {
		evaluation := gatewayapi.WorkflowEvaluation{Executions: []gatewayapi.EvaluationExecution{{
			State:     gatewayapi.EvaluationExecutionStateCompleted,
			RunStatus: new(gatewayapi.WorkflowRunStatusSucceeded),
			Tokens:    new(100.0), ToolCalls: new(4), DurationSeconds: duration,
			Judgment: &gatewayapi.EvaluationJudgment{Correctness: 4, Efficiency: 4},
		}}}
		scoreEvaluation(&evaluation)
		if evaluation.Executions[0].Score == nil || *evaluation.Executions[0].Score != 95 {
			t.Fatalf("duration %v changed scoring: %+v", duration, evaluation.Executions[0])
		}
	}
}

// TestEvaluationParallelRuns checks admission, recovery, slot refill and cancellation.
func TestEvaluationParallelRuns(t *testing.T) {
	for _, concurrency := range []int{1, 3, 5} {
		t.Run(fmt.Sprint(concurrency), func(t *testing.T) {
			scheme := runtime.NewScheme()
			if err := agentzv1alpha1.AddToScheme(scheme); err != nil {
				t.Fatal(err)
			}
			k8s := fake.NewClientBuilder().WithScheme(scheme).Build()
			service := &Service{k8sClient: k8s}
			job := workflowdb.WorkflowRunEvaluation{
				TenantNamespace: "test", AgentName: "agent", WorkflowName: "workflow",
			}
			evaluation := gatewayapi.WorkflowEvaluation{
				Id: uuid.New(), Request: gatewayapi.WorkflowEvaluationRequest{
					Concurrency: concurrency, TimeoutSeconds: 37,
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
			// Losing a later run must release its slot even while the first run is active.
			var finished agentzv1alpha1.WorkflowRun
			key := client.ObjectKey{Namespace: "test", Name: evaluation.Executions[concurrency-1].RunName}
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

type evaluationVariantCase struct {
	name, body, model, judge, field string
	status, calls                   int
	unavailable                     bool
}

// TestEvaluationVariants checks exact runtime membership and catalog failures
// before execution or judge retry can create work.
func TestEvaluationVariants(t *testing.T) {
	catalog := `{"providers":[{"id":"provider","models":{"model":{"variants":{"low":{}}}}}]}`
	tests := []evaluationVariantCase{
		{name: "base needs no catalog", status: 503},
		{name: "fetch once for executions and judge", body: catalog, model: "low", judge: "low", status: 200, calls: 1},
		{name: "unknown execution variant", body: catalog, model: "LOW", field: "models", status: 200, calls: 1},
		{name: "unknown judge variant", body: catalog, judge: "imaginary", field: "judge", status: 200, calls: 1},
		{name: "catalog without model", body: `{"providers":[]}`, model: "low", field: "models", status: 200, calls: 1},
		{name: "catalog unavailable", status: 503, model: "low", calls: 1, unavailable: true},
		{name: "catalog malformed", body: `{`, status: 200, model: "low", calls: 1, unavailable: true},
		{name: "catalog missing providers", body: `{}`, status: 200, model: "low", calls: 1, unavailable: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/config/providers" {
					t.Errorf("unexpected catalog path %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer upstream.Close()
			svc := sandboxTestService(t, nil)
			var sandbox agentzv1alpha1.Sandbox
			key := client.ObjectKey{Namespace: testWorkspaceNS, Name: "workspace-sandbox"}
			err := svc.k8sClient.Get(t.Context(), key, &sandbox)
			if err != nil {
				t.Fatal(err)
			}
			sandbox.Spec.Inference.Models = []agentzv1alpha1.InferenceModelRef{{Provider: "provider", Model: "model"}}
			err = svc.k8sClient.Update(t.Context(), &sandbox)
			if err != nil {
				t.Fatal(err)
			}
			agent := &agentzv1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{
				Name: "agent", Namespace: testWorkspaceNS,
			}}
			agent.Spec.SandboxRef = agentzv1alpha1.ResourceReference{
				Name: sandbox.Name, Scope: agentzv1alpha1.ResourceScopeWorkspace,
			}
			index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
			if err := index.Add(agent); err != nil {
				t.Fatal(err)
			}
			svc.resolver = &resolver{
				agents: listersv1alpha1.NewAgentLister(index), targetOverride: upstream.URL,
			}
			svc.outboundHTTP = upstream.Client()
			model := gatewayapi.EvaluationModel{ProviderId: "provider", ModelId: "model", Variant: &tt.model}
			judge := gatewayapi.EvaluationModel{ProviderId: "provider", ModelId: "model", Variant: &tt.judge}
			fields, err := svc.validateEvaluationModels(
				t.Context(), testWorkspaceNS, agent.Name,
				[]gatewayapi.EvaluationModel{model, model}, judge,
			)
			if calls != tt.calls {
				t.Fatalf("catalog requests = %d, want %d", calls, tt.calls)
			}
			if tt.unavailable {
				var apiErr *apiutil.APIError
				unavailable := errors.As(err, &apiErr) &&
					apiErr.Status == http.StatusServiceUnavailable &&
					apiErr.Code == "model_catalog_unavailable"
				if !unavailable {
					t.Fatalf("catalog error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.field == "" && len(fields) != 0 {
				t.Fatalf("unexpected errors: %+v", fields)
			}
			if tt.field != "" && (len(fields) == 0 || fields[0].Field != tt.field) {
				t.Fatalf("field errors = %+v, want %s", fields, tt.field)
			}
		})
	}
}

// TestEvaluationJudgeSchema compiles the format actually sent to the judge and
// checks evidence constraints without changing shared request validation.
func TestEvaluationJudgeSchema(t *testing.T) {
	doc, err := gatewayapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	original, err := json.Marshal(doc.Components.Schemas["EvaluationJudgment"])
	if err != nil {
		t.Fatal(err)
	}
	judgment := gatewayapi.EvaluationJudgment{
		Correctness: 4, Efficiency: 4, Summary: "Complete",
		Evidence: []string{"Correct result"}, Limitations: []string{},
		References: &[]gatewayapi.EvaluationEvidenceReference{{
			EvidenceIndex: 0, SessionId: "execution", MessageId: "answer",
		}},
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/session":
			_, _ = w.Write([]byte(`{"id":"judge"}`))
		case "/session/judge/message":
			var input gatewayapi.SessionPromptJSONRequestBody
			err := json.NewDecoder(r.Body).Decode(&input)
			if err != nil {
				t.Error(err)
				return
			}
			format, err := input.Format.AsOpencodeOutputFormatJsonSchema()
			if err != nil {
				t.Error(err)
				return
			}
			compiler := jsonschema.NewCompiler()
			err = compiler.AddResource("judgment.json", format.Schema)
			if err != nil {
				t.Error(err)
				return
			}
			schema, err := compiler.Compile("judgment.json")
			if err != nil {
				t.Error(err)
				return
			}
			for _, session := range []string{"execution", ""} {
				(*judgment.References)[0].SessionId = session
				raw, err := json.Marshal(judgment)
				if err != nil {
					t.Error(err)
					return
				}
				value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
				if err != nil {
					t.Error(err)
					return
				}
				err = schema.Validate(value)
				if (err == nil) != (session != "") {
					t.Errorf("evidence session %q: validation error = %v", session, err)
				}
				if session != "" {
					_, _ = fmt.Fprintf(w, `{"info":{"parentID":%q,"structured":%s},"parts":[]}`, *input.MessageID, raw)
				}
			}
		case "/session/judge/abort", "/session/judge":
			_, _ = w.Write([]byte(`true`))
		default:
			t.Errorf("unexpected judge request %s", r.URL.Path)
		}
	}))
	defer upstream.Close()
	index := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	err = index.Add(&agentzv1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{
		Name: "agent", Namespace: "test",
	}})
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{openAPI: doc, resolver: &resolver{
		agents: listersv1alpha1.NewAgentLister(index), targetOverride: upstream.URL,
	}}
	evaluation := gatewayapi.WorkflowEvaluation{
		Id: uuid.New(), Workflow: gatewayapi.Workflow{AgentName: "agent"},
	}
	execution := gatewayapi.EvaluationExecution{}
	err = service.judgeEvaluation(t.Context(), "test", &evaluation, &execution)
	if err != nil {
		t.Fatal(err)
	}
	if execution.Judgment == nil {
		t.Fatal("judge response was not retained")
	}
	after, err := json.Marshal(doc.Components.Schemas["EvaluationJudgment"])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, after) {
		t.Fatal("judge serialization changed the shared OpenAPI schema")
	}
}
