package observer

import (
	"context"
	"errors"
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

type retryStore struct {
	attempts int
	rows     int
	cancel   context.CancelFunc
}

func (s *retryStore) insertBatch(_ context.Context, b batch) error {
	s.attempts++
	if s.attempts == 1 {
		if s.cancel != nil {
			s.cancel()
		}
		return errors.New("temporary failure")
	}
	s.rows += len(b.apps)
	return nil
}
func TestSinkRetainsFailedBatch(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		ctx, cancel := context.WithCancel(t.Context())
		events := make(chan event, 2)
		events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "first"}}
		events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "buffered"}}
		close(events)
		store := &retryStore{}
		if shutdown {
			store.cancel = cancel
		}
		sink := &sink{
			store:  store,
			stats:  &stats{},
			cfg:    Config{BatchSize: 1, FlushInterval: time.Millisecond},
			events: events,
		}
		sink.run(ctx)
		cancel()
		if store.attempts != 3 || store.rows != 2 {
			t.Fatalf("shutdown=%v: accepted events lost after recovery: attempts=%d rows=%d", shutdown, store.attempts, store.rows)
		}
	}
}

type unavailableStore struct{}

func (unavailableStore) insertBatch(context.Context, batch) error { return errors.New("unavailable") }
func TestSinkStopsWithRetainedBatchOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	events := make(chan event, 1)
	events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "accepted"}}
	sink := &sink{
		store:  unavailableStore{},
		stats:  &stats{},
		cfg:    Config{BatchSize: 1, FlushInterval: time.Hour},
		events: events,
	}
	done := make(chan struct{})
	go func() { sink.run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(12 * time.Second):
		t.Fatal("failed batch prevented shutdown")
	}
}
