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
	flush := func() {
		current := b
		b = batch{}
		if current.count() == 0 {
			return
		}
		// Finish accepted events when producer shutdown cancels the parent.
		writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := s.store.insertBatch(writeCtx, current); err != nil {
			atomic.AddUint64(&s.stats.failed, 1)
			slog.ErrorContext(writeCtx, "flush observer batch", slog.Any("error", err))
			return
		}
		atomic.AddUint64(&s.stats.flushed, 1)
	}

	for {
		select {
		case ev, ok := <-s.events:
			if !ok {
				flush()
				return
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
