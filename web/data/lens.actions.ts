"use server"

import {
  getMcpGraph,
  getAppMcpGraph,
  getAppOperation,
  getAppTraceChart,
  listAppSpans,
  listAppSessions,
  type ListAppSessionsData,
  listAppTraces,
  type AppSpan,
  type AppTrace,
  getSpanDetail,
  listChatSessions,
  listFileObservability,
  listFileObservabilitySummary,
  listNetworkObservability,
  listNetworkObservabilitySummary,
  listProcessObservability,
  listProcessObservabilitySummary,
  listSpans,
  listTraceSessions,
  type ProcessObservabilityEventAggregated,
  type FileObservabilityEventAggregated,
  type NetworkObservabilityEventAggregated,
  type GetMcpGraphData,
  type ListSpansData,
  type ListTraceSessionsData,
  type Span,
  type AppPayload,
  type TraceSession,
  type WorkspaceType,
} from "@/lib/gateway/client"
import type {
  LensSubject,
  TraceSubject,
  FileTelemetryActionResponse,
  FileTelemetryRow,
  ListSpansActionResponse,
  ListTracesActionResponse,
  McpGraphActionResponse,
  NetworkTelemetryActionResponse,
  NetworkTelemetryRow,
  ProcessTelemetryActionResponse,
  ProcessTelemetryRow,
  RuntimeTelemetryTab,
  RuntimeTelemetryTabActionResponse,
  SpanDetailActionResponse,
  SpanDetailPayloadSection,
  SpanListItem,
  EventsChartActionResponse,
  EventsChartData,
  EventsChartPoint,
  TraceListItem,
  TraceSessionFilterActionResponse,
  TraceSessionFilterItem,
} from "@/data/types"
import { dayjs, formatDurationMs, formatRecentTimestamp } from "@/lib/format"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { createAgentOpencodeClient } from "@/lib/opencode/server-client"
import { readTraceRecording, readToolContent } from "@/lib/trace-recording"

const maxChartPoints = 25
const chartSourceLimit = 100

/** Resolve an exact trace even when it is outside the first list page. */
// ponytail: scan session pages; add a server trace filter if large sessions need it.
export async function findTraceAction(subject: TraceSubject, traceID: string, workspaceId: string) {
  let pageToken: string | undefined
  do {
    const result = await listTracesAction(
      subject,
      { limit: 100, page_token: pageToken },
      workspaceId
    )
    if (result.error) return { error: result.error }
    const trace = result.data.traces.find((trace) => trace.traceId === traceID)
    if (trace) return { data: trace }
    pageToken = result.data.nextPageToken || undefined
  } while (pageToken)
  return { error: { code: "not_found", message: "No Lens recording was found for this trace." } }
}

type DayjsDate = ReturnType<typeof dayjs>
type AggregatedTelemetryEvent = {
  last_seen: string
  occurrences: number
}
export async function listTracesAction(
  subject: TraceSubject,
  query: ListTraceSessionsData["query"] | undefined,
  workspaceId: string
): Promise<ListTracesActionResponse> {
  const client = getGatewayServerClient(workspaceId)
  let traces: (TraceSession | AppTrace)[]
  let nextPageToken: string
  if (subject.kind !== "agent") {
    const result = await listAppTraces({
      path: { clientID: subject.clientID },
      query: {
        ...query,
        session_id: subject.kind === "external-agent" ? subject.sessionId : undefined,
      },
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    traces = result.data.traces
    nextPageToken = result.data.next_page_token
  } else {
    const result = await listTraceSessions({
      path: { agentName: subject.name, sessionID: subject.sessionId },
      query,
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    traces = result.data.trace_sessions
    nextPageToken = result.data.next_page_token
  }
  return {
    data: {
      traces: traceListItems(traces, subject),
      nextPageToken,
      hasNextPage: nextPageToken.length > 0,
      limit: query?.limit ?? 25,
    },
    error: undefined,
  }
}

export async function getTraceChartAction(
  subject: TraceSubject,
  query: ListTraceSessionsData["query"] | undefined,
  workspaceId: string
): Promise<EventsChartActionResponse> {
  const client = getGatewayServerClient(workspaceId)
  if (subject.kind !== "agent") {
    const result = await getAppTraceChart({
      path: { clientID: subject.clientID },
      query: {
        ...query,
        session_id: subject.kind === "external-agent" ? subject.sessionId : undefined,
      },
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    return {
      data: {
        points: result.data.points.map((point) => ({
          label: dayjs(point.time).format("MMM D, h:mm A"),
          count: point.count,
        })),
        total: result.data.points.reduce((total, point) => total + point.count, 0),
      },
      error: undefined,
    }
  }
  const result = await listTraceSessions({
    client,
    path: { agentName: subject.name, sessionID: subject.sessionId },
    query: { ...query, limit: chartSourceLimit },
  })
  if (result.error) return { data: undefined, error: result.error }
  return {
    data: {
      points: traceChartPoints(result.data.trace_sessions),
      total: result.data.trace_sessions.length,
    },
    error: undefined,
  }
}

export async function listAppSessionsAction(
  clientID: string,
  workspaceId: string,
  query?: ListAppSessionsData["query"]
) {
  const result = await listAppSessions({
    path: { clientID },
    query,
    client: getGatewayServerClient(workspaceId),
  })
  if (result.error) return { data: undefined, error: result.error }
  return { data: result.data, error: undefined }
}

export async function listTraceSessionFilterAction(
  agentName: string,
  workspaceId: string,
  workspaceType: WorkspaceType
): Promise<TraceSessionFilterActionResponse> {
  if (workspaceType === "coding") {
    const client = getGatewayServerClient(workspaceId)
    const sessions: TraceSessionFilterItem[] = []
    let pageToken: string | undefined
    for (;;) {
      const result = await listChatSessions({
        client,
        query: { agent_name: agentName, limit: 50, page_token: pageToken },
      })
      if (result.error) return { data: undefined, error: result.error }
      for (const session of result.data.sessions) {
        sessions.push({ sessionId: session.session_id, title: session.title || session.session_id })
      }
      if (!result.data.has_next_page) return { data: sessions, error: undefined }
      pageToken = result.data.next_page_token
    }
  }

  const client = await createAgentOpencodeClient(agentName, { workspaceId })
  const sessionListResult = await client.session.list()
  if (!sessionListResult.data) {
    return {
      data: undefined,
      error: {
        code: sessionListResult.response.status === 404 ? "not_found" : "session_list_failed",
        message: "Could not load trace sessions",
      },
    }
  }

  const sessions: TraceSessionFilterItem[] = sessionListResult.data.map((session) => ({
    sessionId: session.id,
    title: session.title || session.id,
  }))

  return { data: sessions, error: undefined }
}

export async function listSpansAction(
  path: { subject: TraceSubject; traceID: string },
  query: ListSpansData["query"],
  workspaceId: string
): Promise<ListSpansActionResponse> {
  const client = getGatewayServerClient(workspaceId)
  const subject = path.subject
  let spans: SpanListItem[]
  let nextPageToken: string
  if (subject.kind !== "agent") {
    const result = await listAppSpans({
      path: { clientID: subject.clientID, traceID: path.traceID },
      query,
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    spans = spanListItems(result.data.spans, subject, () => undefined)
    nextPageToken = result.data.next_page_token
  } else {
    const result = await listSpans({
      path: { agentName: subject.name, sessionID: subject.sessionId, traceID: path.traceID },
      query,
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    spans = spanListItems(result.data.spans, subject, (span) => span.llm_finish_reason)
    nextPageToken = result.data.next_page_token
  }
  return { data: { spans, nextPageToken, hasNextPage: nextPageToken.length > 0 }, error: undefined }
}

export async function getSpanDetailAction(
  path: { subject: TraceSubject; traceID: string; spanID: string; operationID: number },
  workspaceId: string
): Promise<SpanDetailActionResponse> {
  const client = getGatewayServerClient(workspaceId)
  const subject = path.subject
  let span: Span | AppSpan
  let payload: AppPayload
  let toolError = "null"
  let finishReason: string | undefined
  if (subject.kind !== "agent") {
    const result = await getAppOperation({
      path: { clientID: subject.clientID, operationID: path.operationID },
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    span = result.data.span
    payload = result.data.payload
    toolError = result.data.tool_error
  } else {
    const result = await getSpanDetail({
      path: {
        agentName: subject.name,
        sessionID: subject.sessionId,
        traceID: path.traceID,
        spanID: path.spanID,
      },
      client,
    })
    if (result.error) return { data: undefined, error: result.error }
    span = result.data.span
    payload = {
      input_messages: JSON.stringify(result.data.payload.input_messages, null, 2),
      output_messages: JSON.stringify(result.data.payload.output_messages, null, 2),
      tool_arguments: JSON.stringify(result.data.payload.tool_arguments, null, 2),
      tool_result: JSON.stringify(result.data.payload.tool_result, null, 2),
    }
    finishReason = result.data.span.llm_finish_reason
  }
  return {
    data: {
      span: spanListItem({
        span,
        subject,
        llmFinishReason: finishReason,
        offsetPercent: 0,
        durationMs: span.duration_ns === null ? null : span.duration_ns / 1_000_000,
        durationPercent: 100,
        depth: span.parent_span_id ? 1 : 0,
      }),
      payload: [
        payloadSection("input_messages", "Input", payload.input_messages),
        payloadSection("output_messages", "Output", payload.output_messages),
        payloadSection("tool_arguments", "Tool arguments", payload.tool_arguments),
        payloadSection("tool_result", "Tool result", payload.tool_result),
        payloadSection("tool_error", "Tool error", toolError),
      ],
    },
    error: undefined,
  }
}

/** getTraceRecordingAction fetches one bounded page of captured activity. */
export async function getTraceRecordingAction(
  subject: TraceSubject,
  traceID: string,
  workspaceId: string,
  pageToken?: string
) {
  const client = getGatewayServerClient(workspaceId)
  const query = { limit: 50, page_token: pageToken, include_recording: true }
  const page =
    subject.kind === "agent"
      ? await listSpans({
          path: { agentName: subject.name, sessionID: subject.sessionId, traceID },
          query,
          client,
        })
      : await listAppSpans({ path: { clientID: subject.clientID, traceID }, query, client })
  if (page.error) return { data: undefined, error: page.error }
  return {
    data: {
      steps: readTraceRecording(page.data.recording),
      nextPageToken: page.data.next_page_token,
    },
    error: undefined,
  }
}

export async function getMcpGraphAction(
  subject: LensSubject,
  query: GetMcpGraphData["query"],
  workspaceId: string
): Promise<McpGraphActionResponse> {
  const client = getGatewayServerClient(workspaceId)
  const result =
    subject.kind !== "agent"
      ? await getAppMcpGraph({
          path: { clientID: subject.clientID },
          query: {
            ...query,
            session_id: subject.kind === "external-agent" ? subject.sessionId : undefined,
          },
          client,
        })
      : await getMcpGraph({ path: { agentName: subject.name }, query, client })
  if (result.error) return { data: undefined, error: result.error }
  return { data: result.data, error: undefined }
}

export async function getRuntimeTelemetryTabAction({
  agent_name,
  started_after,
  started_before,
  tab,
  page_token,
  workspace_id,
}: {
  agent_name: string
  started_after: string
  started_before: string
  tab: RuntimeTelemetryTab
  page_token?: string
  workspace_id: string
}): Promise<RuntimeTelemetryTabActionResponse> {
  const query = {
    limit: 25,
    page_token: page_token ?? undefined,
    event_time_after: isoDateTimeParam(started_after),
    event_time_before: isoDateTimeParam(started_before),
  }

  if (tab === "process") {
    const result = await listProcessObservability({
      path: { agentName: agent_name },
      query,
      client: getGatewayServerClient(workspace_id),
    })
    if (result.error) {
      return { data: undefined, error: result.error }
    }

    return {
      data: {
        tab,
        events: result.data.events,
        nextPageToken: result.data.next_page_token,
        hasNextPage: result.data.next_page_token.length > 0,
      },
      error: undefined,
    }
  }

  if (tab === "file") {
    const result = await listFileObservability({
      path: { agentName: agent_name },
      query,
      client: getGatewayServerClient(workspace_id),
    })
    if (result.error) {
      return { data: undefined, error: result.error }
    }

    return {
      data: {
        tab,
        events: result.data.events,
        nextPageToken: result.data.next_page_token,
        hasNextPage: result.data.next_page_token.length > 0,
      },
      error: undefined,
    }
  }

  const result = await listNetworkObservability({
    path: { agentName: agent_name },
    query,
    client: getGatewayServerClient(workspace_id),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  return {
    data: {
      tab: "network",
      events: result.data.events,
      nextPageToken: result.data.next_page_token,
      hasNextPage: result.data.next_page_token.length > 0,
    },
    error: undefined,
  }
}

const maxTelemetryChartPoints = 5
const defaultPageSize = 25

function rowTelemetryEvent(event: ProcessObservabilityEventAggregated): ProcessTelemetryRow {
  return {
    process: event.process,
    command: event.command_invocation || event.parent_process,
    action: event.action,
    occurrences: event.occurrences,
    lastSeen: formatRecentTimestamp(event.last_seen),
  }
}

function fileTelemetryEvent(event: FileObservabilityEventAggregated): FileTelemetryRow {
  return {
    filePath: event.file_path_accessed,
    process: event.command_invocation || event.process,
    action: event.action,
    occurrences: event.occurrences,
    lastSeen: formatRecentTimestamp(event.last_seen),
  }
}

function networkTelemetryEvent(event: NetworkObservabilityEventAggregated): NetworkTelemetryRow {
  return {
    destinationDomain: event.destination_domain || "",
    destinationIP: event.destination_ip,
    destinationPort: event.destination_port,
    protocol: event.protocol,
    action: event.action,
    occurrences: event.occurrences,
    lastSeen: formatRecentTimestamp(event.last_seen),
  }
}

function computeTelemetryChartFromAggregated(events: AggregatedTelemetryEvent[]): EventsChartData {
  const [firstEvent] = events
  if (!firstEvent) {
    return { points: [], total: 0 }
  }

  let minTime = dayjs(firstEvent.last_seen)
  let maxTime = minTime
  for (const event of events) {
    const seenAt = dayjs(event.last_seen)
    if (seenAt.isBefore(minTime)) {
      minTime = seenAt
    }
    if (seenAt.isAfter(maxTime)) {
      maxTime = seenAt
    }
  }

  const total = events.reduce((sum, event) => sum + event.occurrences, 0)
  const from = minTime
  const to = maxTime
  const totalMs = to.valueOf() - from.valueOf()
  const bucketCount = maxTelemetryChartPoints

  if (totalMs === 0) {
    return {
      points: [
        {
          label: from.format("MMM D, h:mm A"),
          count: total,
        },
      ],
      total,
    }
  }

  const bucketMs = totalMs / bucketCount
  const buckets = Array.from({ length: bucketCount }, () => 0)

  for (const event of events) {
    const eventMs = dayjs(event.last_seen).valueOf()
    let bucketIndex = Math.floor((eventMs - from.valueOf()) / bucketMs)
    if (bucketIndex < 0) bucketIndex = 0
    if (bucketIndex >= bucketCount) bucketIndex = bucketCount - 1
    buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + event.occurrences
  }

  const points = buckets
    .map((count, index) => {
      const bucketStart = from.add(index * bucketMs)
      const bucketEnd = bucketStart.add(bucketMs)

      return {
        label: chartPointLabel(bucketStart, bucketEnd),
        count,
      }
    })
    .filter((p) => p.count > 0)

  return {
    points,
    total,
  }
}

export async function getProcessTelemetryAction({
  agent_name,
  event_time_after,
  event_time_before,
  page_token,
  workspace_id,
}: {
  agent_name: string
  event_time_after: string
  event_time_before: string
  page_token?: string
  workspace_id: string
}): Promise<ProcessTelemetryActionResponse> {
  const query = {
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    event_time_after: isoDateTimeParam(event_time_after),
    event_time_before: isoDateTimeParam(event_time_before),
  }

  const result = await listProcessObservabilitySummary({
    path: { agentName: agent_name },
    query,
    client: getGatewayServerClient(workspace_id),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events
  const rows = events.map(rowTelemetryEvent)
  const chart = computeTelemetryChartFromAggregated(events)
  const nextPageToken = result.data.next_page_token

  return {
    data: {
      rows,
      chart,
      nextPageToken,
      hasNextPage: nextPageToken.length > 0,
    },
    error: undefined,
  }
}

export async function getFileTelemetryAction({
  agent_name,
  event_time_after,
  event_time_before,
  page_token,
  workspace_id,
}: {
  agent_name: string
  event_time_after: string
  event_time_before: string
  page_token?: string
  workspace_id: string
}): Promise<FileTelemetryActionResponse> {
  const query = {
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    event_time_after: isoDateTimeParam(event_time_after),
    event_time_before: isoDateTimeParam(event_time_before),
  }

  const result = await listFileObservabilitySummary({
    path: { agentName: agent_name },
    query,
    client: getGatewayServerClient(workspace_id),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events
  const rows = events.map(fileTelemetryEvent)
  const chart = computeTelemetryChartFromAggregated(events)
  const nextPageToken = result.data.next_page_token

  return {
    data: {
      rows,
      chart,
      nextPageToken,
      hasNextPage: nextPageToken.length > 0,
    },
    error: undefined,
  }
}

export async function getNetworkTelemetryAction({
  agent_name,
  event_time_after,
  event_time_before,
  page_token,
  workspace_id,
}: {
  agent_name: string
  event_time_after: string
  event_time_before: string
  page_token?: string
  workspace_id: string
}): Promise<NetworkTelemetryActionResponse> {
  const query = {
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    event_time_after: isoDateTimeParam(event_time_after),
    event_time_before: isoDateTimeParam(event_time_before),
  }

  const result = await listNetworkObservabilitySummary({
    path: { agentName: agent_name },
    query,
    client: getGatewayServerClient(workspace_id),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events
  const rows = events.map(networkTelemetryEvent)
  const chart = computeTelemetryChartFromAggregated(events)
  const nextPageToken = result.data.next_page_token

  return {
    data: {
      rows,
      chart,
      nextPageToken,
      hasNextPage: nextPageToken.length > 0,
    },
    error: undefined,
  }
}

function traceChartPoints(traces: readonly TraceSession[]): EventsChartPoint[] {
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
    .map(([minuteMs, count]) => ({
      label: dayjs(minuteMs).format("MMM D, h:mm A"),
      count,
    }))
}

function chartPointLabel(startedAfter: DayjsDate, startedBefore: DayjsDate) {
  if (startedAfter.isSame(startedBefore, "day")) {
    return startedAfter.format("MMM D, h:mm A")
  }

  return `${startedAfter.format("MMM D")} - ${startedBefore.format("MMM D")}`
}

function traceListItems(
  traces: readonly (TraceSession | AppTrace)[],
  subject: TraceSubject
): TraceListItem[] {
  const totalDurationMs = traces.reduce((total, trace) => total + trace.duration_ns / 1_000_000, 0)
  let cumulativeDurationMs = 0
  return traces.map((trace, index) => {
    const startedAt = dayjs(trace.started_at)
    const endedAt = dayjs(trace.ended_at)
    const totalTokens =
      trace.input_tokens === null || trace.output_tokens === null
        ? null
        : trace.input_tokens + trace.output_tokens
    const durationMs = trace.duration_ns / 1_000_000
    cumulativeDurationMs += durationMs
    const startedDate = startedAt.isValid()
      ? formatRecentTimestamp(trace.started_at, "MMM D, YYYY")
      : trace.started_at
    const startedTime = startedAt.isValid() ? startedAt.format("h:mm A") : trace.started_at
    const endedTime = endedAt.isValid() ? endedAt.format("h:mm A") : trace.ended_at

    return {
      subject,
      traceId: trace.trace_id,
      startedAt: trace.started_at,
      endedAt: trace.ended_at,
      startedDate,
      startedTime,
      endedTime,
      duration: formatDurationMs(durationMs),
      durationMs,
      cumulativeDurationMs,
      cumulativeDurationPercent:
        totalDurationMs === 0 ? 0 : (cumulativeDurationMs / totalDurationMs) * 100,
      waterfallDelayMs: index * 70,
      spanCount: trace.span_count,
      errorCount: trace.error_count,
      toolCount: trace.tool_count,
      modelCount: trace.model_count,
      inputTokens: trace.input_tokens,
      outputTokens: trace.output_tokens,
      totalTokens,
      tokenRatio:
        totalTokens === null || totalTokens === 0 || trace.output_tokens === null
          ? 0
          : trace.output_tokens / totalTokens,
    }
  })
}

function spanListItems<T extends Span | AppSpan>(
  spans: T[],
  subject: TraceSubject,
  finishReason: (span: T) => string | undefined
): SpanListItem[] {
  if (spans.length === 0) {
    return []
  }

  const times = spans.flatMap((span) => [
    dayjs(span.start_time).valueOf(),
    dayjs(span.end_time).valueOf(),
  ])
  const traceStartMs = Math.min(...times)
  const traceEndMs = Math.max(...times)
  const traceDurationMs = Math.max(traceEndMs - traceStartMs, 0)

  const byID = new Map(spans.map((span) => [span.span_id, span]))

  return spans.map((span) => {
    const startMs = dayjs(span.start_time).valueOf()
    const durationMs = span.duration_ns === null ? null : span.duration_ns / 1_000_000
    const offsetMs = Math.max(startMs - traceStartMs, 0)
    let depth = 0
    let parent = byID.get(span.parent_span_id)
    while (parent && depth < 4) {
      depth++
      parent = byID.get(parent.parent_span_id)
    }

    return spanListItem({
      span,
      subject,
      llmFinishReason: finishReason(span),
      offsetPercent: percent(offsetMs, traceDurationMs),
      durationMs,
      durationPercent: durationMs === null ? 0 : percent(durationMs, traceDurationMs),
      depth,
    })
  })
}

function spanListItem({
  span,
  subject,
  llmFinishReason,
  offsetPercent,
  durationMs,
  durationPercent,
  depth,
}: {
  span: Span | AppSpan
  subject: TraceSubject
  llmFinishReason?: string
  offsetPercent: number
  durationMs: number | null
  durationPercent: number
  depth: number
}): SpanListItem {
  const totalTokens =
    span.input_tokens === null || span.output_tokens === null
      ? null
      : span.input_tokens + span.output_tokens
  const hasError =
    span.status_code === "ERROR" || span.error_type.length > 0 || span.error_message.length > 0
  const startLabel = formatRecentTimestamp(span.start_time)
  const endLabel = formatRecentTimestamp(span.end_time)

  return {
    id: span.id,
    subject,
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    startLabel,
    endLabel,
    duration: durationMs === null ? undefined : formatDurationMs(durationMs),
    durationMs,
    displayName: operationLabel(span),
    spanClass: span.span_class,
    kind: span.kind,
    statusCode: span.status_code,
    llmFinishReason,
    hasError,
    error: span.error_message,
    spanType: spanType(span),
    depth,
    inputTokens: span.input_tokens,
    cachedInputTokens: span.cached_input_tokens,
    cachedWriteTokens: span.cached_write_tokens,
    outputTokens: span.output_tokens,
    totalTokens,
    offsetPercent,
    durationPercent: Math.max(durationPercent, durationMs !== null && durationMs > 0 ? 0.5 : 0),
  }
}

function payloadSection(key: string, label: string, json: string): SpanDetailPayloadSection {
  let kind: "arguments" | "result" | "error" | undefined
  if (key === "tool_arguments") kind = "arguments"
  if (key === "tool_result") kind = "result"
  if (key === "tool_error") kind = "error"
  const tool = kind ? readToolContent(json, kind) : undefined
  const content = tool?.format === "text" ? { text: tool.text } : { code: json }
  return { key, label, content, empty: json === "null" || json === "[]" || json === "{}" }
}

function operationLabel(span: Span | AppSpan) {
  if (span.operation_name === "invoke_agent") {
    return "Agent run"
  }

  if (span.tool_name) {
    return span.tool_name
  }

  if (span.model) {
    return "Model call"
  }

  return span.operation_name || span.name
}

function spanType(span: Span | AppSpan): SpanListItem["spanType"] {
  if (span.operation_name === "invoke_agent") {
    return "agent"
  }

  if (span.tool_name) {
    return "tool"
  }

  if (span.model) {
    return "model"
  }

  return "span"
}

function percent(value: number, total: number) {
  if (total <= 0) {
    return 0
  }

  return (value / total) * 100
}

function isoDateTimeParam(value: string) {
  const date = dayjs(value)
  return date.isValid() ? date.toISOString() : value
}
