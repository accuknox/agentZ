"use server"

import { listTraces, type ListTracesData, type Trace } from "@/lib/gateway/client"
import type {
  ListTracesActionResponse,
  TraceChartActionResponse,
  TraceChartPoint,
  TraceListItem,
} from "@/data/types"
import { dayjs } from "@/lib/dayjs"

const maxChartPoints = 25
const chartSourceLimit = 100
type DayjsDate = ReturnType<typeof dayjs>

export async function listTracesAction(
  query: ListTracesData["query"]
): Promise<ListTracesActionResponse> {
  const result = await listTraces({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  return {
    data: {
      traces: traceListItems(result.data.traces),
      nextPageToken: result.data.next_page_token,
      hasNextPage: result.data.next_page_token.length > 0,
      limit: query.limit ?? 25,
    },
    error: undefined,
  }
}

export async function getTraceChartAction(
  query: ListTracesData["query"]
): Promise<TraceChartActionResponse> {
  const result = await listTraces({
    query: {
      session_id: query.session_id,
      started_after: query.started_after,
      started_before: query.started_before,
      limit: chartSourceLimit,
    },
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const points = traceChartPoints(result.data.traces)

  return {
    data: {
      points,
      total: result.data.traces.length,
      granularity: points.length === 1 ? "single bucket" : `${points.length} buckets`,
    },
    error: undefined,
  }
}

function traceChartPoints(traces: Trace[]): TraceChartPoint[] {
  if (traces.length === 0) {
    return []
  }

  const minuteBuckets = new Map<number, number>()
  for (const trace of traces) {
    const minuteMs = dayjs(trace.started_at).startOf("minute").valueOf()
    minuteBuckets.set(minuteMs, (minuteBuckets.get(minuteMs) ?? 0) + 1)
  }

  return [...minuteBuckets.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, maxChartPoints)
    .map(([minuteMs, count]) => {
      const startedAfter = dayjs(minuteMs)
      const startedBefore = startedAfter.endOf("minute")

      return {
        label: chartPointLabel(startedAfter, startedBefore),
        count,
        startedAfter: startedAfter.toISOString(),
        startedBefore: startedBefore.toISOString(),
      }
    })
}

function chartPointLabel(startedAfter: DayjsDate, startedBefore: DayjsDate) {
  if (startedAfter.isSame(startedBefore, "day")) {
    return startedAfter.format("MMM D, h:mm A")
  }

  return `${startedAfter.format("MMM D")} - ${startedBefore.format("MMM D")}`
}

function traceListItems(traces: Trace[]): TraceListItem[] {
  const durations = traces.map((trace) => trace.duration_ns / 1_000_000)
  const totalDurationMs = durations.reduce((total, durationMs) => total + durationMs, 0)
  let cumulativeDurationMs = 0

  return traces.map((trace, index) => {
    cumulativeDurationMs += durations[index] ?? 0

    return traceListItem({
      trace,
      cumulativeDurationMs,
      cumulativeDurationPercent:
        totalDurationMs === 0 ? 0 : (cumulativeDurationMs / totalDurationMs) * 100,
      waterfallDelayMs: index * 70,
    })
  })
}

function traceListItem({
  trace,
  cumulativeDurationMs,
  cumulativeDurationPercent,
  waterfallDelayMs,
}: {
  trace: Trace
  cumulativeDurationMs: number
  cumulativeDurationPercent: number
  waterfallDelayMs: number
}): TraceListItem {
  const totalTokens = trace.input_tokens + trace.output_tokens
  const durationMs = trace.duration_ns / 1_000_000

  return {
    traceId: trace.trace_id,
    sessionId: trace.session_id,
    startedAt: trace.started_at,
    endedAt: trace.ended_at,
    startedDate: dayjs(trace.started_at).format("MMM D, YYYY"),
    startedTime: dayjs(trace.started_at).format("h:mm A"),
    endedTime: dayjs(trace.ended_at).format("h:mm A"),
    duration: formatDuration(durationMs),
    durationMs,
    cumulativeDurationMs,
    cumulativeDurationPercent,
    waterfallDelayMs,
    spanCount: trace.span_count,
    errorCount: trace.error_count,
    toolCount: trace.tool_count,
    modelCount: trace.model_count,
    inputTokens: trace.input_tokens,
    outputTokens: trace.output_tokens,
    totalTokens,
    tokenRatio: totalTokens === 0 ? 0 : trace.output_tokens / totalTokens,
  }
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`
  }

  return `${dayjs.duration(durationMs).asSeconds().toFixed(2)} s`
}
