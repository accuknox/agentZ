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
	writeCtx := context.WithoutCancel(ctx)
	var stop context.CancelFunc
	flush := func() {
		if b.count() == 0 {
			return
		}
		attempt, cancel := context.WithTimeout(writeCtx, 10*time.Second)
		defer cancel()
		if err := s.store.insertBatch(attempt, b); err != nil {
			atomic.AddUint64(&s.stats.failed, 1)
			slog.ErrorContext(attempt, "flush observer batch", slog.Any("error", err))
			return
		}
		b = batch{}
		atomic.AddUint64(&s.stats.flushed, 1)
	}

	shutdown := ctx.Done()
	closed := false
	for {
		if stop == nil && (closed || ctx.Err() != nil) {
			// Recover the retained batch and consume accepted events under one
			// shutdown budget. Producers may still be completing an export.
			writeCtx, stop = context.WithTimeout(writeCtx, 10*time.Second)
			defer stop()
			shutdown = nil
			ticker.Reset(250 * time.Millisecond)
			flush()
		}
		if writeCtx.Err() != nil || closed && b.count() == 0 {
			return
		}
		// Backpressure bounds a retained failed batch until the next attempt.
		events := s.events
		if closed || b.count() >= s.cfg.BatchSize {
			events = nil
		}
		select {
		case <-shutdown:
			continue
		case <-writeCtx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				closed = true
				continue
			}
			b.add(ev)
			if b.count() >= s.cfg.BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}
