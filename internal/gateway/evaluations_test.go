package gateway

import (
	"testing"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

type evaluationScoreCase struct {
	name     string
	quality  float64
	passed   bool
	tokens   float64
	calls    int
	duration float64
	weight   float64
	want     float64
}

func TestEvaluationScore(t *testing.T) {
	tests := []evaluationScoreCase{
		{"reference", 1, true, 1000, 4, 20, .2, 100},
		{"half resources cannot exceed quality", .9, true, 500, 2, 10, .2, 90},
		{"double all resources", 1, true, 2000, 8, 40, .2, 90},
		{"tokens alone exceed reference", 1, true, 2000, 4, 20, .3, 95},
		{"quality gate", .79, true, 1, 0, .1, .2, 0},
		{"failed mandatory check", .9, false, 1, 0, .1, .2, 0},
		{"zero quality", 0, false, 1, 0, .1, .2, 0},
		{"quality only pilot", .9, true, 1000000, 4000, 20000, 0, 90},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := gatewayapi.EvaluationPolicy{
				MinimumQuality: .8, TokenReference: 1000, ToolReference: 4,
				DurationReference: 20, EfficiencyWeight: tt.weight,
			}
			grade := gatewayapi.EvaluationGradeResult{
				Quality: tt.quality, Checks: []gatewayapi.EvaluationCheck{{Passed: tt.passed}},
			}
			attempt := gatewayapi.EvaluationAttempt{
				Tokens: &tt.tokens, TaskCalls: &tt.calls, DurationSeconds: &tt.duration,
			}
			got, err := evaluationScore(policy, grade, attempt)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("score = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEvaluationScoreRequiresMeasuredResources(t *testing.T) {
	policy := gatewayapi.EvaluationPolicy{MinimumQuality: .8, TokenReference: 1000, ToolReference: 4, DurationReference: 20}
	grade := gatewayapi.EvaluationGradeResult{Quality: 1, Checks: []gatewayapi.EvaluationCheck{{Passed: true}}}
	attempts := []gatewayapi.EvaluationAttempt{
		{TaskCalls: new(0), DurationSeconds: new(1.0)},
		{Tokens: new(100.0), DurationSeconds: new(1.0)},
		{Tokens: new(100.0), TaskCalls: new(0)},
	}
	for _, attempt := range attempts {
		if _, err := evaluationScore(policy, grade, attempt); err == nil {
			t.Fatal("missing resource evidence was scored")
		}
	}
}
