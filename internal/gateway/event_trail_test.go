package gateway

import (
	"testing"
	"time"

	gatewayapi "github.com/accuknox/agentz/internal/gateway/openapi"
)

func TestCompileEventTrailFilters(t *testing.T) {
	t.Parallel()

	from := "2026-08-01T00:00:00Z"
	to := "2026-08-13T23:59:59Z"
	tests := []struct {
		name    string
		filters []gatewayapi.EventTrailFilter
		wantErr bool
	}{
		{
			name: "categorical fields and date range compile",
			filters: []gatewayapi.EventTrailFilter{
				{Field: gatewayapi.ActorType, Values: []string{"user", "system"}},
				{Field: gatewayapi.Result, Values: []string{"failed", "denied"}},
				{Field: gatewayapi.CreatedAt, Values: []string{from, to}},
			},
		},
		{
			name: "duplicate fields are rejected",
			filters: []gatewayapi.EventTrailFilter{
				{Field: gatewayapi.Category, Values: []string{"access"}},
				{Field: gatewayapi.Category, Values: []string{"resource"}},
			},
			wantErr: true,
		},
		{
			name: "invalid enum value is rejected",
			filters: []gatewayapi.EventTrailFilter{
				{Field: gatewayapi.Result, Values: []string{"unknown"}},
			},
			wantErr: true,
		},
		{
			name: "reversed date range is rejected",
			filters: []gatewayapi.EventTrailFilter{
				{Field: gatewayapi.CreatedAt, Values: []string{to, from}},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			clause, err := compileEventTrailFilters(tt.filters)
			if tt.wantErr {
				if err == nil {
					t.Fatal("compileEventTrailFilters() error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("compileEventTrailFilters() error = %v", err)
			}
			if len(clause.actorTypes) != 2 || len(clause.results) != 2 {
				t.Fatalf("compileEventTrailFilters() clause = %#v", clause)
			}
			if clause.createdAfter.Time.Format(time.RFC3339) != from ||
				clause.createdBefore.Time.Format(time.RFC3339) != to {
				t.Fatalf("compileEventTrailFilters() date range = %#v", clause)
			}
		})
	}
}
