package observer

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dbStore struct {
	pool *pgxpool.Pool
}

func (s *dbStore) insertBatch(ctx context.Context, b batch) error {
	if b.empty() {
		return nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if len(b.processes) > 0 {
		rows := make([][]any, 0, len(b.processes))
		for _, ev := range b.processes {
			rows = append(rows, []any{
				ev.sessionID,
				ev.eventTime,
				ev.podNamespace,
				ev.podName,
				ev.process,
				ev.parentProcess,
				ev.commandInvocation,
				ev.action,
				ev.source,
			})
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_process_events"},
			[]string{
				"session_id",
				"event_time",
				"pod_namespace",
				"pod_name",
				"process",
				"parent_process",
				"command_invocation",
				"action",
				"source",
			},
			pgx.CopyFromRows(rows),
		)
		if err != nil {
			return fmt.Errorf("copy process events: %w", err)
		}
	}

	if len(b.files) > 0 {
		rows := make([][]any, 0, len(b.files))
		for _, ev := range b.files {
			rows = append(rows, []any{
				ev.sessionID,
				ev.eventTime,
				ev.podNamespace,
				ev.podName,
				ev.filePathAccessed,
				ev.process,
				ev.commandInvocation,
				ev.action,
				ev.source,
			})
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_file_events"},
			[]string{
				"session_id",
				"event_time",
				"pod_namespace",
				"pod_name",
				"file_path_accessed",
				"process",
				"command_invocation",
				"action",
				"source",
			},
			pgx.CopyFromRows(rows),
		)
		if err != nil {
			return fmt.Errorf("copy file events: %w", err)
		}
	}

	if len(b.networks) > 0 {
		rows := make([][]any, 0, len(b.networks))
		for _, ev := range b.networks {
			rows = append(rows, []any{
				ev.sessionID,
				ev.eventTime,
				ev.podNamespace,
				ev.podName,
				ev.destinationDomain,
				ev.destinationIP,
				ev.destinationPort,
				ev.protocol,
				ev.action,
				ev.source,
			})
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_network_events"},
			[]string{
				"session_id",
				"event_time",
				"pod_namespace",
				"pod_name",
				"destination_domain",
				"destination_ip",
				"destination_port",
				"protocol",
				"action",
				"source",
			},
			pgx.CopyFromRows(rows),
		)
		if err != nil {
			return fmt.Errorf("copy network events: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
