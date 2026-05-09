package observer

import (
	"context"
	"fmt"

	observerdb "github.com/accuknox/clawarmor/internal/observer/db"
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
				ev.agentName,
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
				"agent_name",
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
				ev.agentName,
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
				"agent_name",
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
				ev.agentName,
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
				"agent_name",
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

	if len(b.traces) > 0 {
		if err := insertTraceEvents(ctx, tx, b.traces); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func insertTraceEvents(ctx context.Context, tx pgx.Tx, traces []traceSpanEvent) error {
	q := observerdb.New(tx)
	spans := make([]observerdb.InsertTraceSpanParams, 0, len(traces))
	payloads := make([]observerdb.InsertTraceSpanPayloadParams, 0, len(traces))
	for _, ev := range traces {
		spans = append(spans, observerdb.InsertTraceSpanParams{
			AgentName:          ev.agentName,
			TraceID:            ev.traceID,
			SpanID:             ev.spanID,
			ParentSpanID:       ev.parentSpanID,
			StartTime:          ev.startTime,
			EndTime:            ev.endTime,
			DurationNs:         ev.durationNS,
			Name:               ev.name,
			OperationName:      ev.operationName,
			Kind:               ev.kind,
			StatusCode:         ev.statusCode,
			ErrorType:          ev.errorType,
			ErrorMessage:       ev.errorMessage,
			ConversationID:     ev.conversationID,
			RunID:              ev.runID,
			RequestID:          ev.requestID,
			Model:              ev.model,
			ToolName:           ev.toolName,
			InputTokens:        ev.inputTokens,
			OutputTokens:       ev.outputTokens,
			CachedInputTokens:  ev.cachedInputTokens,
			TimeToFirstTokenMs: ev.timeToFirstTokenMS,
			PodNamespace:       ev.podNamespace,
			PodName:            ev.podName,
		})
		p := ev.payload
		payloads = append(payloads, observerdb.InsertTraceSpanPayloadParams{
			TraceID:        ev.traceID,
			SpanID:         ev.spanID,
			StartTime:      ev.startTime,
			InputMessages:  p.inputMessages,
			OutputMessages: p.outputMessages,
			ToolArguments:  p.toolArguments,
			ToolResult:     p.toolResult,
			Metadata:       p.metadata,
		})
	}

	var batchErr error
	q.InsertTraceSpan(ctx, spans).Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("insert trace spans: %w", batchErr)
	}

	q.InsertTraceSpanPayload(ctx, payloads).Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("insert trace span payloads: %w", batchErr)
	}

	q.RefreshTraceSummary(ctx, uniqueTraceIDs(traces)).Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("upsert trace summaries: %w", batchErr)
	}

	return nil
}

func uniqueTraceIDs(traces []traceSpanEvent) [][]byte {
	seen := map[string]struct{}{}
	ids := make([][]byte, 0, len(traces))
	for _, ev := range traces {
		key := string(ev.traceID)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		ids = append(ids, ev.traceID)
	}
	return ids
}
