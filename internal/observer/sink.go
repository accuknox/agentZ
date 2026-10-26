package observer

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

type store interface {
	insertBatch(ctx context.Context, batch batch) error
}

type stats struct {
	received uint64
	filtered uint64
	flushed  uint64
	failed   uint64
}

// values returns the current absolute counters.
func (s *stats) values() stats {
	return stats{
		received: atomic.LoadUint64(&s.received),
		filtered: atomic.LoadUint64(&s.filtered),
		flushed:  atomic.LoadUint64(&s.flushed),
		failed:   atomic.LoadUint64(&s.failed),
	}
}

type sink struct {
	store  store
	stats  *stats
	cfg    Config
	events <-chan event
}

func (s *sink) run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.FlushInterval)
	defer ticker.Stop()

	var b batch
	flush := func(parent context.Context) bool {
		if b.count() == 0 {
			return true
		}
		// Finish accepted events when producer shutdown cancels the parent.
		writeCtx, cancel := context.WithTimeout(parent, 10*time.Second)
		defer cancel()
		if err := s.store.insertBatch(writeCtx, b); err != nil {
			atomic.AddUint64(&s.stats.failed, 1)
			slog.ErrorContext(writeCtx, "flush observer batch", slog.Any("error", err))
			return false
		}
		b = batch{}
		atomic.AddUint64(&s.stats.flushed, 1)
		return true
	}

	drain := func() {
		deadline, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		for !flush(deadline) {
			select {
			case <-deadline.Done():
				return
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	shutdown := ctx.Done()
	for {
		// Backpressure bounds a retained failed batch until the next flush attempt.
		events := s.events
		if b.count() >= s.cfg.BatchSize {
			events = nil
		}
		select {
		case <-shutdown:
			shutdown = nil
			if b.count() >= s.cfg.BatchSize {
				drain()
				return
			}
		case ev, ok := <-events:
			if !ok {
				drain()
				return
			}
			b.add(ev)
			if b.count() >= s.cfg.BatchSize {
				if !flush(context.WithoutCancel(ctx)) && ctx.Err() != nil {
					drain()
					return
				}
			}
		case <-ticker.C:
			if !flush(context.WithoutCancel(ctx)) && ctx.Err() != nil {
				drain()
				return
			}
		}
	}
}
