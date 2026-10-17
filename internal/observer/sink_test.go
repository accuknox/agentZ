package observer

import (
	"context"
	"testing"
	"time"

	observerdb "github.com/accuknox/agentz/internal/observer/db"
)

type shutdownStore struct {
	rows int
	err  error
}

func (s *shutdownStore) insertBatch(ctx context.Context, b batch) error {
	s.err = ctx.Err()
	s.rows += len(b.apps)
	return s.err
}

func TestSinkDrainsAfterProducersStop(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	events := make(chan event, 2)
	store := &shutdownStore{}
	sink := &sink{
		store:  store,
		stats:  &stats{},
		cfg:    Config{BatchSize: 500, FlushInterval: time.Hour},
		events: events,
	}
	done := make(chan struct{})
	go func() { sink.run(ctx); close(done) }()
	events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "before-cancel"}}
	cancel()
	// An in-flight OTLP export may finish after the process receives SIGTERM.
	events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "in-flight"}}
	close(events)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sink did not stop after producers closed the channel")
	}
	if store.err != nil || store.rows != 2 {
		t.Fatalf("shutdown lost accepted telemetry: rows=%d err=%v", store.rows, store.err)
	}
}
