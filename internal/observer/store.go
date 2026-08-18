package observer

import (
	"context"
	"fmt"

	observerdb "github.com/accuknox/agentz/internal/observer/db"
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
			rows = append(
				rows,
				[]any{
					ev.tenantNamespace,
					ev.agentName,
					ev.eventTime,
					ev.podNamespace,
					ev.podName,
					ev.process,
					ev.parentProcess,
					ev.commandInvocation,
					ev.action,
					ev.source,
				},
			)
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_process_events"},
			[]string{
				"tenant_namespace",
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
			rows = append(
				rows,
				[]any{
					ev.tenantNamespace,
					ev.agentName,
					ev.eventTime,
					ev.podNamespace,
					ev.podName,
					ev.filePathAccessed,
					ev.process,
					ev.commandInvocation,
					ev.action,
					ev.source,
				},
			)
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_file_events"},
			[]string{
				"tenant_namespace",
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
			rows = append(
				rows,
				[]any{
					ev.tenantNamespace,
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
				},
			)
		}
		_, err = tx.CopyFrom(
			ctx,
			pgx.Identifier{"observer_network_events"},
			[]string{
				"tenant_namespace",
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
		if err := insertTraceEventBatch(ctx, tx, b.traces); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func insertTraceEventBatch(ctx context.Context, tx pgx.Tx, traces []traceSpanEvent) error {
	q := observerdb.New(tx)
	spans := make([]observerdb.InsertTraceSpanParams, 0, len(traces))
	payloads := make([]observerdb.InsertTraceSpanPayloadParams, 0, len(traces))
	mcpInvocations := make([]observerdb.InsertMCPToolInvocationParams, 0, len(traces))
	traceIDs := make([][]byte, 0, len(traces))
	traceSessions := make([]observerdb.RefreshTraceSessionSummaryParams, 0, len(traces))
	seenTraceIDs := make(map[string]struct{}, len(traces))
	seenTraceSessions := make(map[string]struct{}, len(traces))
	mcpLastCalledByKey := make(map[string]observerdb.UpsertMCPToolLastCalledParams, len(traces))
	for _, ev := range traces {
		spans = append(
			spans,
			observerdb.InsertTraceSpanParams{
				TenantNamespace:    ev.tenantNamespace,
				AgentName:          ev.agentName,
				SessionID:          ev.sessionID,
				TraceID:            ev.traceID,
				SpanID:             ev.spanID,
				ParentSpanID:       ev.parentSpanID,
				StartTime:          ev.startTime,
				EndTime:            ev.endTime,
				DurationNs:         ev.durationNS,
				Name:               ev.name,
				SpanClass:          ev.spanClass,
				OperationName:      ev.operationName,
				Kind:               ev.kind,
				StatusCode:         ev.statusCode,
				ErrorType:          ev.errorType,
				ErrorMessage:       ev.errorMessage,
				Model:              ev.model,
				ToolName:           ev.toolName,
				InputTokens:        ev.inputTokens,
				OutputTokens:       ev.outputTokens,
				CachedInputTokens:  ev.cachedInputTokens,
				CachedWriteTokens:  ev.cachedWriteTokens,
				CostUsd:            ev.costUSD,
				LlmFinishReason:    ev.llmFinishReason,
				ResourceAttributes: ev.resourceAttributes,
				SpanAttributes:     ev.spanAttributes,
			},
		)
		p := ev.payload
		payloads = append(
			payloads,
			observerdb.InsertTraceSpanPayloadParams{
				TraceID:        ev.traceID,
				SpanID:         ev.spanID,
				StartTime:      ev.startTime,
				InputMessages:  p.inputMessages,
				OutputMessages: p.outputMessages,
				ToolArguments:  p.toolArguments,
				ToolResult:     p.toolResult,
			},
		)
		if ev.mcpToolCall != nil {
			call := ev.mcpToolCall
			mcpInvocations = append(
				mcpInvocations,
				observerdb.InsertMCPToolInvocationParams{
					TenantNamespace:   ev.tenantNamespace,
					AgentName:         call.agentName,
					TraceID:           call.traceID,
					SpanID:            call.spanID,
					StartTime:         call.startTime,
					EndTime:           call.endTime,
					DurationNs:        call.durationNS,
					McpConnectionName: call.mcpConnectionName,
					ToolName:          call.toolName,
					SessionID:         call.sessionID,
					Failed:            call.failed,
				},
			)

			lastCalledKey := ev.tenantNamespace + "\x00" + call.agentName + "\x00" + call.mcpConnectionName + "\x00" + call.toolName
			lastCalled := observerdb.UpsertMCPToolLastCalledParams{
				TenantNamespace:   ev.tenantNamespace,
				AgentName:         call.agentName,
				McpConnectionName: call.mcpConnectionName,
				ToolName:          call.toolName,
				LastCalledAt:      call.startTime,
			}
			current, ok := mcpLastCalledByKey[lastCalledKey]
			if !ok || call.startTime.After(current.LastCalledAt) {
				mcpLastCalledByKey[lastCalledKey] = lastCalled
			}
		}

		traceKey := string(ev.traceID)
		if _, ok := seenTraceIDs[traceKey]; !ok {
			seenTraceIDs[traceKey] = struct{}{}
			traceIDs = append(traceIDs, ev.traceID)
		}

		sessionKey := traceKey + "\x00" + ev.sessionID
		if _, ok := seenTraceSessions[sessionKey]; ok {
			continue
		}
		seenTraceSessions[sessionKey] = struct{}{}
		traceSessions = append(
			traceSessions,
			observerdb.RefreshTraceSessionSummaryParams{
				TraceID:   ev.traceID,
				SessionID: ev.sessionID,
			},
		)
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

	mcpLastCalled := make([]observerdb.UpsertMCPToolLastCalledParams, 0, len(mcpLastCalledByKey))
	for _, item := range mcpLastCalledByKey {
		mcpLastCalled = append(mcpLastCalled, item)
	}

	if len(mcpInvocations) > 0 {
		q.InsertMCPToolInvocation(ctx, mcpInvocations).Exec(func(_ int, err error) {
			if err != nil && batchErr == nil {
				batchErr = err
			}
		})
		if batchErr != nil {
			return fmt.Errorf("insert mcp tool invocations: %w", batchErr)
		}
	}

	if len(mcpLastCalled) > 0 {
		q.UpsertMCPToolLastCalled(ctx, mcpLastCalled).Exec(func(_ int, err error) {
			if err != nil && batchErr == nil {
				batchErr = err
			}
		})
		if batchErr != nil {
			return fmt.Errorf("upsert mcp tool last-called summary: %w", batchErr)
		}
	}

	q.RefreshTraceSummary(ctx, traceIDs).Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("upsert trace summaries: %w", batchErr)
	}

	q.RefreshTraceSessionSummary(ctx, traceSessions).Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("upsert trace session summaries: %w", batchErr)
	}

	return nil
}
