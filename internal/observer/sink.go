package observer

import (
	"context"
	"errors"
	"fmt"

	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type store interface {
	insertBatch(ctx context.Context, batch batch) error
}

type stats struct {
	received   uint64
	filtered   uint64
	flushed    uint64
	failed     uint64
	discarded  uint64
	pending    uint64
	lastCommit int64
}

// values returns the current absolute counters.
func (s *stats) values() stats {
	return stats{
		received:   atomic.LoadUint64(&s.received),
		filtered:   atomic.LoadUint64(&s.filtered),
		flushed:    atomic.LoadUint64(&s.flushed),
		failed:     atomic.LoadUint64(&s.failed),
		discarded:  atomic.LoadUint64(&s.discarded),
		pending:    atomic.LoadUint64(&s.pending),
		lastCommit: atomic.LoadInt64(&s.lastCommit),
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
	var pending []batch
	writeCtx := context.WithoutCancel(ctx)
	var stop context.CancelFunc
	flush := func() {
		if b.count() == 0 && len(pending) == 0 {
			return
		}
		attempt, cancel := context.WithTimeout(writeCtx, 10*time.Second)
		defer cancel()
		defer func() {
			n := b.count()
			for _, part := range pending {
				n += part.count()
			}
			atomic.StoreUint64(&s.stats.pending, uint64(n))
		}()
		failures, discarded := 0, 0
		defer func() {
			if discarded > 10 {
				slog.WarnContext(
					attempt,
					"discarded invalid telemetry records",
					"discarded", discarded,
					"unlogged", discarded-10,
				)
			}
		}()
		for attempt.Err() == nil {
			if b.count() == 0 {
				if len(pending) == 0 {
					return
				}
				b = pending[len(pending)-1]
				pending[len(pending)-1] = batch{}
				pending = pending[:len(pending)-1]
			}
			err := s.store.insertBatch(attempt, b)
			if err == nil {
				// Split batches share backing arrays. Release committed payloads without
				// touching their uncommitted siblings. The healthy path needs no scan.
				if len(pending) > 0 {
					b.release()
				}
				b = batch{}
				atomic.AddUint64(&s.stats.flushed, 1)
				atomic.StoreInt64(&s.stats.lastCommit, time.Now().UnixNano())
				continue
			}
			atomic.AddUint64(&s.stats.failed, 1)
			var pg *pgconn.PgError
			permanent := false
			if errors.As(err, &pg) {
				switch pg.Code {
				case "22P05", "22021", "22P02", "22003", "22001", "22007", "22008", "23502", "23503", "23514":
					permanent = true
				}
			}
			if !permanent {
				if pg != nil {
					slog.ErrorContext(attempt, "flush observer batch", "sqlstate", pg.Code)
					return
				}
				slog.ErrorContext(attempt, "flush observer batch", slog.Any("error", err))
				return
			}
			failures++
			var bad batch
			var record *recordError
			indexed := errors.As(err, &record)
			switch {
			case b.count() == 1:
				bad, b = b, batch{}
			case indexed && failures == 1:
				var tail batch
				b, tail = b.split(record.index)
				bad, tail = tail.split(1)
				if tail.count() > 0 {
					pending = append(pending, tail)
				}
			default:
				// COPY has no row index. Subdivision also prevents dense
				// failures from repeatedly serializing an almost-full batch.
				var tail batch
				b, tail = b.split(b.count() / 2)
				pending = append(pending, tail)
				continue
			}
			discarded++
			atomic.AddUint64(&s.stats.discarded, 1)
			if discarded <= 10 {
				attrs := []any{
					"sqlstate", pg.Code,
					"table", pg.TableName,
					"column", pg.ColumnName,
					"constraint", pg.ConstraintName,
				}
				if indexed {
					attrs = append(attrs, "stage", record.stage)
				}
				switch {
				case len(bad.traces) > 0:
					ev := bad.traces[0]
					attrs = append(
						attrs,
						"kind", "trace",
						"namespace", ev.tenantNamespace,
						"agent", ev.agentName,
						"trace_id", fmt.Sprintf("%x", ev.traceID),
						"span_id", fmt.Sprintf("%x", ev.spanID),
					)
				case len(bad.apps) > 0:
					ev := bad.apps[0]
					attrs = append(
						attrs,
						"kind", "app",
						"organization", ev.OrganizationID,
						"workspace", ev.WorkspaceID,
						"client", ev.ClientID,
						"trace_id", fmt.Sprintf("%x", ev.TraceID),
						"span_id", fmt.Sprintf("%x", ev.SpanID),
					)
				case len(bad.processes) > 0:
					ev := bad.processes[0]
					attrs = append(
						attrs,
						"kind", "process",
						"namespace", ev.tenantNamespace,
						"agent", ev.agentName,
						"time", ev.eventTime,
					)
				case len(bad.files) > 0:
					ev := bad.files[0]
					attrs = append(
						attrs,
						"kind", "file",
						"namespace", ev.tenantNamespace,
						"agent", ev.agentName,
						"time", ev.eventTime,
					)
				case len(bad.networks) > 0:
					ev := bad.networks[0]
					attrs = append(
						attrs,
						"kind", "network",
						"namespace", ev.tenantNamespace,
						"agent", ev.agentName,
						"time", ev.eventTime,
					)
				case len(bad.guardrails) > 0:
					ev := bad.guardrails[0]
					attrs = append(
						attrs,
						"kind", "guardrail",
						"namespace", ev.namespace,
						"trace_id", fmt.Sprintf("%x", ev.row.TraceID),
						"span_id", fmt.Sprintf("%x", ev.row.SpanID),
					)
				}
				// PostgreSQL Detail/Where/Message can contain captured content.
				slog.WarnContext(attempt, "discard invalid telemetry record", attrs...)
			}
			bad.release()
		}
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
		if writeCtx.Err() != nil || closed && b.count() == 0 && len(pending) == 0 {
			return
		}
		// Backpressure bounds a retained failed batch until the next attempt.
		events := s.events
		if closed || len(pending) > 0 || b.count() >= s.cfg.BatchSize {
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
