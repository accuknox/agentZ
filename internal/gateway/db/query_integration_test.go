package gatewaydb

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGatewayListEventTrailEventsEncodesEnumFilters(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	organizationID := os.Getenv("TEST_ORGANIZATION_ID")
	if databaseURL == "" || organizationID == "" {
		t.Skip("TEST_DATABASE_URL and TEST_ORGANIZATION_ID are required")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to PostgreSQL: %v", err)
	}
	t.Cleanup(pool.Close)

	_, err = New(pool).GatewayListEventTrailEvents(
		ctx,
		GatewayListEventTrailEventsParams{
			OrganizationID: organizationID,
			RetainedAfter:  pgtype.Timestamptz{Time: time.Now().AddDate(-1, 0, 0), Valid: true},
			ActorTypes:     []string{"user"},
			TargetTypes:    []string{"agent"},
			Results:        []string{"succeeded"},
			PageSize:       1,
		},
	)
	if err != nil {
		t.Fatalf("query Event Trail filters: %v", err)
	}
}
