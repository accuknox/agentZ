package observer

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"

	observerdb "github.com/accuknox/agentz/internal/observer/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tidwall/gjson"
)

type dbStore struct {
	pool *pgxpool.Pool
}

func (s *dbStore) insertBatch(ctx context.Context, b batch) error {
	if b.count() == 0 {
		return nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	q := observerdb.New(tx)

	if len(b.processes) > 0 {
		rows := make([]observerdb.InsertProcessEventsParams, 0, len(b.processes))
		for _, ev := range b.processes {
			rows = append(rows, observerdb.InsertProcessEventsParams{
				TenantNamespace:   ev.tenantNamespace,
				AgentName:         ev.agentName,
				EventTime:         ev.eventTime,
				PodNamespace:      ev.podNamespace,
				PodName:           ev.podName,
				Process:           ev.process,
				ParentProcess:     ev.parentProcess,
				CommandInvocation: ev.commandInvocation,
				Action:            ev.action,
				Source:            ev.source,
			})
		}
		_, err = q.InsertProcessEvents(ctx, rows)
		if err != nil {
			return fmt.Errorf("copy process events: %w", err)
		}
	}

	if len(b.files) > 0 {
		rows := make([]observerdb.InsertFileEventsParams, 0, len(b.files))
		for _, ev := range b.files {
			rows = append(rows, observerdb.InsertFileEventsParams{
				TenantNamespace:   ev.tenantNamespace,
				AgentName:         ev.agentName,
				EventTime:         ev.eventTime,
				PodNamespace:      ev.podNamespace,
				PodName:           ev.podName,
				FilePathAccessed:  ev.filePathAccessed,
				Process:           ev.process,
				CommandInvocation: ev.commandInvocation,
				Action:            ev.action,
				Source:            ev.source,
			})
		}
		_, err = q.InsertFileEvents(ctx, rows)
		if err != nil {
			return fmt.Errorf("copy file events: %w", err)
		}
	}

	if len(b.networks) > 0 {
		rows := make([]observerdb.InsertNetworkEventsParams, 0, len(b.networks))
		for _, ev := range b.networks {
			rows = append(rows, observerdb.InsertNetworkEventsParams{
				TenantNamespace:   ev.tenantNamespace,
				AgentName:         ev.agentName,
				EventTime:         ev.eventTime,
				PodNamespace:      ev.podNamespace,
				PodName:           ev.podName,
				DestinationDomain: ev.destinationDomain,
				DestinationIp:     ev.destinationIP,
				DestinationPort:   ev.destinationPort,
				Protocol:          ev.protocol,
				Action:            ev.action,
				Source:            ev.source,
			})
		}
		_, err = q.InsertNetworkEvents(ctx, rows)
		if err != nil {
			return fmt.Errorf("copy network events: %w", err)
		}
	}

	if len(b.traces) > 0 {
		if err := insertTraceEventBatch(ctx, tx, b.traces); err != nil {
			return err
		}
	}

	if len(b.apps) > 0 {
		if err := insertAppOperationBatch(ctx, q, b.apps); err != nil {
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

// appInvocation is the authenticated scope of a model-visible invocation. Session
// is deliberately absent because Claude MCP requests do not supply it.
type appInvocation struct {
	OrganizationID string `json:"organization_id"`
	WorkspaceID    string `json:"workspace_id"`
	ClientID       string `json:"client_id"`
	UserID         string `json:"user_id"`
	CallID         string `json:"call_id"`
}

func insertAppOperationBatch(ctx context.Context, q *observerdb.Queries, operations []observerdb.InsertAppOperationParams) error {
	invocations := make([]appInvocation, 0)
	lockKeys := make([]string, 0)
	seen := make(map[appInvocation]bool)
	for _, op := range operations {
		ids := []string{op.ToolCallID}
		for _, id := range gjson.GetBytes(op.OutputMessages, "tool_calls.#.id").Array() {
			ids = append(ids, id.Str)
		}
		inputPaths := []string{
			`messages.#(role=="user")#.content.#(type=="tool_result")#.tool_use_id|@flatten`,
			`input.#(type=="function_call_output")#.call_id`,
			`input.#(type=="custom_tool_call_output")#.call_id`,
			`messages.#(role=="tool")#.tool_call_id`,
		}
		for _, path := range inputPaths {
			for _, id := range gjson.GetBytes(op.InputMessages, path).Array() {
				ids = append(ids, id.Str)
			}
		}
		for _, id := range ids {
			if id == "" || len(id) > 512 {
				continue
			}
			invocation := appInvocation{
				OrganizationID: op.OrganizationID, WorkspaceID: op.WorkspaceID, ClientID: op.ClientID,
				UserID: op.UserID, CallID: id,
			}
			if seen[invocation] {
				continue
			}
			seen[invocation] = true
			invocations = append(invocations, invocation)
			key, err := json.Marshal(invocation)
			if err != nil {
				return fmt.Errorf("encode invocation lock key: %w", err)
			}
			lockKeys = append(lockKeys, string(key))
		}
	}
	// Every writer takes the same ordered transaction locks before inserting any
	// affected observations. Repair statements then see the preceding commit.
	if len(lockKeys) > 0 {
		if err := q.LockAppInvocationKeys(ctx, lockKeys); err != nil {
			return fmt.Errorf("lock app invocations: %w", err)
		}
	}
	// Root upserts follow the same order even when batches have no invocation IDs.
	slices.SortStableFunc(operations, func(a, b observerdb.InsertAppOperationParams) int {
		return cmp.Or(cmp.Compare(a.OrganizationID, b.OrganizationID), cmp.Compare(a.WorkspaceID, b.WorkspaceID),
			cmp.Compare(a.ClientID, b.ClientID), cmp.Compare(a.UserID, b.UserID),
			cmp.Compare(a.SessionID, b.SessionID), cmp.Compare(a.TurnID, b.TurnID))
	})
	ids := make([]int64, 0, len(operations))
	var batchErr error
	q.InsertAppOperation(ctx, operations).QueryRow(func(_ int, id int64, err error) {
		if batchErr == nil {
			batchErr = err
		}
		if id != 0 {
			ids = append(ids, id)
		}
	})
	if batchErr != nil {
		return fmt.Errorf("insert app operations: %w", batchErr)
	}
	if len(ids) == 0 {
		return nil
	}
	if err := q.AssignAppRuns(ctx, ids); err != nil {
		return fmt.Errorf("assign app turns: %w", err)
	}
	if err := q.AssignAppToolRuns(ctx, ids); err != nil {
		return fmt.Errorf("assign emitted tools: %w", err)
	}
	if len(invocations) == 0 {
		return nil
	}
	keys, err := json.Marshal(invocations)
	if err != nil {
		return fmt.Errorf("encode app invocations: %w", err)
	}
	if err := q.RefreshAppRunCorrelations(ctx, keys); err != nil {
		return fmt.Errorf("correlate app MCP calls: %w", err)
	}
	if err := q.RefreshAppToolResults(ctx, keys); err != nil {
		return fmt.Errorf("correlate app tool results: %w", err)
	}
	params := observerdb.RefreshAppRunStatusesParams{OperationIds: ids, Invocations: keys}
	err = q.RefreshAppRunStatuses(ctx, params)
	if err != nil {
		return fmt.Errorf("refresh app turn status: %w", err)
	}
	return nil
}
