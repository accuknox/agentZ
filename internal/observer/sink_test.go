package observer

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strings"

	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

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

// recoveryStore models rollback, indexed statements and unindexed COPY errors.
type recoveryStore struct {
	seen        map[string]int
	attempts    int
	transient   bool
	interrupted bool
	code        string
}

func (s *recoveryStore) insertBatch(_ context.Context, b batch) error {
	s.attempts++
	if s.code != "" && s.attempts == 1 {
		return &pgconn.PgError{Code: s.code}
	}
	if s.transient && len(s.seen) > 0 && !s.interrupted {
		s.interrupted = true
		return &pgconn.PgError{Code: "40001"}
	}
	for _, ev := range b.processes {
		if strings.HasPrefix(ev.process, "bad") {
			return &pgconn.PgError{Code: "22021"}
		}
	}
	for i, ev := range b.apps {
		if strings.HasPrefix(ev.ClientID, "bad") {
			code := s.code
			if code == "" {
				code = "22P05"
			}
			return &recordError{
				error: &pgconn.PgError{Code: code},
				index: len(b.processes) + i,
				stage: "app operation",
			}
		}
	}
	for _, ev := range b.processes {
		s.seen[ev.process]++
	}
	for _, ev := range b.apps {
		s.seen[ev.ClientID]++
	}
	return nil
}

type recoveryCase struct {
	name      string
	size      int
	allBad    bool
	copy      bool
	transient bool
	shutdown  bool
}

func TestSinkIsolatesRejectedEvents(t *testing.T) {
	cases := []recoveryCase{
		{name: "indexed mixed", size: 20},
		{name: "copy mixed", size: 20, copy: true},
		{name: "dense indexed", size: 500, allBad: true},
		{name: "dense copy", size: 500, allBad: true, copy: true},
		{name: "partial commit then retry", size: 20, transient: true},
		{name: "shutdown recovery", size: 20, shutdown: true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			events := make(chan event, tt.size+1)
			want := make(map[string]int)
			discarded := 0
			for i := 0; i < tt.size; i++ {
				id := fmt.Sprintf("good-%d", i)
				if tt.allBad || i%3 == 0 {
					id = fmt.Sprintf("bad-%d", i)
					discarded++
				} else {
					want[id] = 1
				}
				ev := event{app: &observerdb.InsertAppOperationParams{ClientID: id}}
				if tt.copy {
					ev = event{process: &processEvent{process: id}}
				}
				events <- ev
			}
			// A later event must still be consumed after the retained batch recovers.
			events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "later"}}
			want["later"] = 1
			close(events)
			if tt.shutdown {
				cancel()
			}
			store := &recoveryStore{seen: make(map[string]int), transient: tt.transient}
			s := &sink{
				store:  store,
				stats:  &stats{},
				cfg:    Config{BatchSize: tt.size, FlushInterval: time.Millisecond},
				events: events,
			}
			done := make(chan struct{})
			go func() { defer close(done); s.run(ctx) }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("recovery did not drain")
			}
			if !maps.Equal(store.seen, want) {
				t.Fatalf("committed records = %v; want %v", store.seen, want)
			}
			if s.stats.discarded != uint64(discarded) || s.stats.pending != 0 {
				t.Fatalf("stats = %+v", s.stats.values())
			}
			if store.attempts > 2*tt.size+20 {
				t.Fatalf("dense rejection caused %d attempts", store.attempts)
			}
			if tt.transient && !store.interrupted {
				t.Fatal("transient failure was not exercised")
			}
		})
	}
}

func TestSinkRetriesSystemErrors(t *testing.T) {
	codes := []string{"08006", "40001", "40P01", "42501", "42P01", "2200H", "23505"}
	for _, code := range codes {
		t.Run(code, func(t *testing.T) {
			events := make(chan event, 1)
			events <- event{app: &observerdb.InsertAppOperationParams{ClientID: "good"}}
			close(events)
			store := &recoveryStore{seen: make(map[string]int), code: code}
			s := &sink{
				store:  store,
				stats:  &stats{},
				cfg:    Config{BatchSize: 1, FlushInterval: time.Millisecond},
				events: events,
			}
			s.run(t.Context())
			if store.seen["good"] != 1 || s.stats.discarded != 0 || store.attempts != 2 {
				t.Fatalf("system error mishandled: attempts=%d stats=%+v", store.attempts, s.stats.values())
			}
		})
	}
}
