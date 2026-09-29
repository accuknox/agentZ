package workflowdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// evaluationQueries isolates fixtures in a temporary table on one connection.
// EVALUATION_TEST_DATABASE_URL must point to a migrated development database.
func evaluationQueries(tb testing.TB, history, messages int) (*Queries, uuid.UUID) {
	tb.Helper()
	dsn := os.Getenv("EVALUATION_TEST_DATABASE_URL")
	if dsn == "" {
		tb.Skip("EVALUATION_TEST_DATABASE_URL is not set")
	}
	ctx := tb.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = conn.Close(context.Background()) })
	_, err = conn.Exec(ctx, "CREATE TEMP TABLE workflow_run_evaluations (LIKE public.workflow_run_evaluations INCLUDING ALL)")
	if err != nil {
		tb.Fatal(err)
	}
	message := `{"info":{"id":"message"},"parts":[{"type":"text","text":"` + strings.Repeat("x", 2000) + `"}]}`
	transcript := `[{"session_id":"session","session":{},"messages":[` + strings.TrimSuffix(strings.Repeat(message+",", messages), ",") + `]}]`
	result := []byte(fmt.Sprintf(`{
  "request": {
    "inputs": {"report": "original", "nested": [true, null, 3]},
    "judge": {"model_id": "judge"}
  },
  "workflow": {},
  "executions": [
    {"run_name": "first", "run": {}, "transcript": %s},
    {"run_name": "second", "run": {}, "transcript": %s}
  ]
}`, transcript, transcript))
	q := New(conn)
	var id uuid.UUID
	for range history {
		id = uuid.New()
		_, err := q.RunEvaluationCreate(ctx, RunEvaluationCreateParams{
			ID: id, TenantNamespace: "benchmark", WorkspaceID: "workspace",
			OrganizationID: "organization", OwnerID: "owner",
			AgentName: "agent", WorkflowName: "workflow",
			Request: []byte(`{"inputs":{"report":"original"}}`), Result: result,
		})
		if err != nil {
			tb.Fatal(err)
		}
	}
	return q, id
}

// TestEvaluationViews checks evidence selection, isolation and saved inputs.
func TestEvaluationViews(t *testing.T) {
	q, id := evaluationQueries(t, 1, 2)
	params := RunEvaluationViewParams{
		ID: id, TenantNamespace: "benchmark", AgentName: "agent", WorkflowName: "workflow",
	}
	for _, run := range []string{"", "first", "second", "missing"} {
		t.Run("transcript="+run, func(t *testing.T) {
			params.TranscriptRun = run
			row, err := q.RunEvaluationView(t.Context(), params)
			if err != nil {
				t.Fatal(err)
			}
			var evaluation gatewayapi.WorkflowEvaluation
			if err := json.Unmarshal(row.Result, &evaluation); err != nil {
				t.Fatal(err)
			}
			inputs, err := json.Marshal(evaluation.Request.Inputs)
			if err != nil {
				t.Fatal(err)
			}
			if string(inputs) != `{"nested":[true,null,3],"report":"original"}` {
				t.Fatalf("saved inputs changed: %s", inputs)
			}
			if len(evaluation.Executions) != 2 {
				t.Fatalf("got %d executions", len(evaluation.Executions))
			}
			for _, execution := range evaluation.Executions {
				want := execution.RunName == run
				if (execution.Transcript != nil) != want || (execution.Run != nil) != want {
					t.Fatalf("unexpected evidence for %s", execution.RunName)
				}
			}
		})
	}
	for _, field := range []*string{&params.TenantNamespace, &params.AgentName, &params.WorkflowName} {
		original := *field
		*field = "different"
		_, err := q.RunEvaluationView(t.Context(), params)
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scope mismatch returned %v", err)
		}
		*field = original
	}
	history, err := q.RunEvaluationList(t.Context(), RunEvaluationListParams{
		TenantNamespace: "benchmark", AgentName: "agent", WorkflowName: "workflow",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 {
		t.Fatalf("got %d history entries", len(history))
	}
	var summary gatewayapi.WorkflowEvaluationSummary
	if err := json.Unmarshal(history[0], &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Judge.ModelId != "judge" || len(summary.Executions) != 2 {
		t.Fatalf("incomplete summary: %+v", summary)
	}
	for _, execution := range summary.Executions {
		if execution.Transcript != nil || execution.Run != nil {
			t.Fatal("history includes execution evidence")
		}
	}
}

// BenchmarkEvaluationHistory measures transcript pruning through the real query.
func BenchmarkEvaluationHistory(b *testing.B) {
	for _, history := range []int{1, 50} {
		for _, messages := range []int{5, 500} {
			b.Run(fmt.Sprintf("history=%d/messages=%d", history, messages), func(b *testing.B) {
				q, _ := evaluationQueries(b, history, messages)
				params := RunEvaluationListParams{
					TenantNamespace: "benchmark", AgentName: "agent", WorkflowName: "workflow",
				}
				b.ReportAllocs()
				for b.Loop() {
					rows, err := q.RunEvaluationList(b.Context(), params)
					if err != nil {
						b.Fatal(err)
					}
					if len(rows) != history {
						b.Fatalf("got %d history entries", len(rows))
					}
				}
			})
		}
	}
}
