"use server"

import {
  getMcpGraph,
  getSpanDetail,
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
  type ProcessObservabilityEvent,
  type FileObservabilityEvent,
  type NetworkObservabilityEvent,
  type GetSpanDetailData,
  type GetMcpGraphData,
  type JsonValue,
  type ListSpansData,
  type ListTraceSessionsData,
  type Span,
  type SpanPayload,
  type TraceSession,
} from "@/lib/gateway/client"
import type {
  FileTelemetryActionResponse,
  FileTelemetryRow,
  ListSpansActionResponse,
  ListTracesActionResponse,
  McpGraphActionResponse,
  NetworkTelemetryActionResponse,
  NetworkTelemetryRow,
  ProcessTelemetryActionResponse,
  ProcessTelemetryRow,
  RuntimeTelemetryActionResponse,
  RuntimeTelemetryTab,
  RuntimeTelemetryTabActionResponse,
  RuntimeTelemetryEventItem,
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

const maxChartPoints = 25
const chartSourceLimit = 100
type DayjsDate = ReturnType<typeof dayjs>
type AggregatedTelemetryEvent = {
  last_seen: string
  occurrences: number
}
type TraceSummary = Pick<
  TraceSession,
  | "trace_id"
  | "agent_name"
  | "started_at"
  | "ended_at"
  | "duration_ns"
  | "span_count"
  | "error_count"
  | "tool_count"
  | "model_count"
  | "input_tokens"
  | "output_tokens"
> & {
  session_id?: string
}

export async function listTraceSessionsAction(
  path: ListTraceSessionsData["path"],
  query: ListTraceSessionsData["query"] | undefined,
  workspaceId: string
): Promise<ListTracesActionResponse> {
  const result = await listTraceSessions({
    path,
    query,
    client: getGatewayServerClient(workspaceId),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  return {
    data: {
      traces: traceListItems(result.data.trace_sessions),
      nextPageToken: result.data.next_page_token,
      hasNextPage: result.data.next_page_token.length > 0,
      limit: query?.limit ?? 25,
    },
    error: undefined,
  }
}

export async function getTraceChartAction(
  path: ListTraceSessionsData["path"],
  query: ListTraceSessionsData["query"] | undefined,
  workspaceId: string
): Promise<EventsChartActionResponse> {
  const result = await listTraceSessions({
    client: getGatewayServerClient(workspaceId),
    path,
    query: { ...query, limit: chartSourceLimit },
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const points = traceChartPoints(result.data.trace_sessions)

  return {
    data: {
      points,
      total: result.data.trace_sessions.length,
    },
    error: undefined,
  }
}

export async function listTraceSessionFilterAction(
  agentName: string,
  workspaceId: string
): Promise<TraceSessionFilterActionResponse> {
  const client = await createAgentOpencodeClient(agentName, { workspaceId })
  const sessionListResult = await client.session.list()
  if (!sessionListResult.data) {
    return { data: [], error: undefined }
  }

  const sessions: TraceSessionFilterItem[] = sessionListResult.data.map((session) => ({
    sessionId: session.id,
    title: session.title || session.id,
  }))

  return { data: sessions, error: undefined }
}

export async function listSpansAction(
  path: ListSpansData["path"],
  query: ListSpansData["query"],
  workspaceId: string
): Promise<ListSpansActionResponse> {
  const result = await listSpans({
    path,
    query,
    client: getGatewayServerClient(workspaceId),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const spans = spanListItems(result.data.spans)

  return {
    data: {
      spans,
      nextPageToken: result.data.next_page_token,
      hasNextPage: result.data.next_page_token.length > 0,
    },
    error: undefined,
  }
}

export async function getSpanDetailAction(
  path: GetSpanDetailData["path"],
  workspaceId: string
): Promise<SpanDetailActionResponse> {
  const result = await getSpanDetail({
    path,
    client: getGatewayServerClient(workspaceId),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const durationMs = result.data.span.duration_ns / 1_000_000

  return {
    data: {
      span: spanListItem({
        span: result.data.span,
        offsetPercent: 0,
        durationMs,
        durationPercent: 100,
        depth: result.data.span.parent_span_id ? 1 : 0,
      }),
      payload: payloadSections(result.data.payload),
      resourceAttributes: payloadSection(
        "resource_attributes",
        "Resource attributes",
        result.data.span.resource_attributes
      ),
      spanAttributes: payloadSection(
        "span_attributes",
        "Span attributes",
        result.data.span.span_attributes
      ),
    },
    error: undefined,
  }
}

export async function getMcpGraphAction(
  path: GetMcpGraphData["path"],
  query: GetMcpGraphData["query"],
  workspaceId: string
): Promise<McpGraphActionResponse> {
  const result = await getMcpGraph({
    path,
    query,
    client: getGatewayServerClient(workspaceId),
  })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  return { data: result.data, error: undefined }
}

export async function getRuntimeTelemetryAction({
  agent_name,
  started_after,
  started_before,
  workspace_id,
}: {
  agent_name: string
  started_after: string
  started_before: string
  workspace_id: string
}): Promise<RuntimeTelemetryActionResponse> {
  const query = {
    limit: 25,
    event_time_after: isoDateTimeParam(started_after),
    event_time_before: isoDateTimeParam(started_before),
  }
  const [processes, files, networks] = await Promise.all([
    listProcessObservability({
      path: { agentName: agent_name },
      query,
      client: getGatewayServerClient(workspace_id),
    }),
    listFileObservability({
      path: { agentName: agent_name },
      query,
      client: getGatewayServerClient(workspace_id),
    }),
    listNetworkObservability({
      path: { agentName: agent_name },
      query,
      client: getGatewayServerClient(workspace_id),
    }),
  ])
  if (processes.error) {
    return { data: undefined, error: processes.error }
  }

  if (files.error) {
    return { data: undefined, error: files.error }
  }

  if (networks.error) {
    return { data: undefined, error: networks.error }
  }

  const events: RuntimeTelemetryEventItem[] = [
    ...processes.data.events.map(processTelemetryEventItem),
    ...files.data.events.map(fileTelemetryEventItem),
    ...networks.data.events.map(networkTelemetryEventItem),
  ].toSorted((left, right) => left.eventTime.localeCompare(right.eventTime))

  return {
    data: {
      events,
      processCount: processes.data.events.length,
      fileCount: files.data.events.length,
      networkCount: networks.data.events.length,
      blockedCount: events.filter((event) => event.action === "Blocked").length,
    },
    error: undefined,
  }
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

    const events = result.data.events.map(processTelemetryEventItem)
    return {
      data: {
        events,
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

    const events = result.data.events.map(fileTelemetryEventItem)
    return {
      data: {
        events,
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

  const events = result.data.events.map(networkTelemetryEventItem)
  return {
    data: {
      events,
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
  if (events.length === 0) {
    return { points: [], total: 0 }
  }

  const [firstEvent, ...restEvents] = events
  if (!firstEvent) {
    return { points: [], total: 0 }
  }

  let minTime = dayjs(firstEvent.last_seen)
  let maxTime = minTime
  for (const event of restEvents) {
    const seenAt = dayjs(event.last_seen)
    if (seenAt.isBefore(minTime)) {
      minTime = seenAt
    }
    if (seenAt.isAfter(maxTime)) {
      maxTime = seenAt
    }
  }

  const from = minTime
  const to = maxTime
  const totalMs = to.valueOf() - from.valueOf()
  const bucketCount = maxTelemetryChartPoints

  if (totalMs === 0) {
    return {
      points: [
        {
          label: from.format("MMM D, h:mm A"),
          count: events.length,
        },
      ],
      total: events.length,
    }
  }

  const bucketMs = totalMs / bucketCount
  const buckets = Array(bucketCount).fill(0)

  for (const event of events) {
    const eventMs = dayjs(event.last_seen).valueOf()
    let bucketIndex = Math.floor((eventMs - from.valueOf()) / bucketMs)
    if (bucketIndex < 0) bucketIndex = 0
    if (bucketIndex >= bucketCount) bucketIndex = bucketCount - 1
    buckets[bucketIndex] += Number(event.occurrences)
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
    total: events.reduce((sum, event) => sum + event.occurrences, 0),
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

function traceChartPoints(traces: readonly TraceSummary[]): EventsChartPoint[] {
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

function traceListItems(traces: readonly TraceSummary[]): TraceListItem[] {
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
  trace: TraceSummary
  cumulativeDurationMs: number
  cumulativeDurationPercent: number
  waterfallDelayMs: number
}): TraceListItem {
  const startedAt = dayjs(trace.started_at)
  const endedAt = dayjs(trace.ended_at)
  const totalTokens = trace.input_tokens + trace.output_tokens
  const durationMs = trace.duration_ns / 1_000_000
  const startedDate = startedAt.isValid()
    ? formatRecentTimestamp(trace.started_at, "MMM D, YYYY")
    : trace.started_at
  const startedTime = startedAt.isValid() ? startedAt.format("h:mm A") : trace.started_at
  const endedTime = endedAt.isValid() ? endedAt.format("h:mm A") : trace.ended_at

  return {
    agentName: trace.agent_name,
    sessionId: trace.session_id ?? "",
    traceId: trace.trace_id,
    startedAt: trace.started_at,
    endedAt: trace.ended_at,
    startedDate,
    startedTime,
    endedTime,
    duration: formatDurationMs(durationMs),
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

function spanListItems(spans: Span[]): SpanListItem[] {
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

  const depths = spanDepths(spans)

  return spans.map((span) => {
    const startMs = dayjs(span.start_time).valueOf()
    const durationMs = span.duration_ns / 1_000_000
    const offsetMs = Math.max(startMs - traceStartMs, 0)

    return spanListItem({
      span,
      offsetPercent: percent(offsetMs, traceDurationMs),
      durationMs,
      durationPercent: percent(durationMs, traceDurationMs),
      depth: depths.get(span.span_id) ?? 0,
    })
  })
}

function spanListItem({
  span,
  offsetPercent,
  durationMs,
  durationPercent,
  depth,
}: {
  span: Span
  offsetPercent: number
  durationMs: number
  durationPercent: number
  depth: number
}): SpanListItem {
  const totalTokens = span.input_tokens + span.output_tokens
  const hasError =
    span.status_code === "ERROR" || span.error_type.length > 0 || span.error_message.length > 0
  const startLabel = formatRecentTimestamp(span.start_time)
  const endLabel = formatRecentTimestamp(span.end_time)

  return {
    id: span.id,
    agentName: span.agent_name,
    sessionId: span.session_id,
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    startLabel,
    endLabel,
    duration: formatDurationMs(durationMs),
    durationMs,
    displayName: displayName(span),
    operationLabel: operationLabel(span),
    spanClass: span.span_class,
    kind: span.kind,
    statusCode: span.status_code,
    llmFinishReason: span.llm_finish_reason,
    hasError,
    error: span.error_message,
    spanType: spanType(span),
    depth,
    inputTokens: span.input_tokens,
    cachedInputTokens: span.cached_input_tokens,
    cachedWriteTokens: span.cached_write_tokens,
    outputTokens: span.output_tokens,
    totalTokens,
    costUSD: span.cost_usd,
    offsetPercent,
    durationPercent: Math.max(durationPercent, durationMs > 0 ? 0.5 : 0),
  }
}

function payloadSections(payload: SpanPayload): SpanDetailPayloadSection[] {
  return [
    payloadSection("input_messages", "Input", payload.input_messages),
    payloadSection("output_messages", "Output", payload.output_messages),
    payloadSection("tool_arguments", "Tool arguments", payload.tool_arguments),
    payloadSection("tool_result", "Tool result", payload.tool_result),
  ]
}

function payloadSection(key: string, label: string, value: JsonValue): SpanDetailPayloadSection {
  const json = JSON.stringify(value, null, 2)
  const preview = jsonPreview(value)

  return {
    key,
    label,
    preview,
    json,
    empty: isEmptyJSON(value),
  }
}

function jsonPreview(value: JsonValue) {
  if (isEmptyJSON(value)) {
    return "Empty"
  }

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value
  }

  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value)
    return keys.slice(0, 4).join(", ") || "Object"
  }

  return String(value)
}

function isEmptyJSON(value: JsonValue) {
  if (value === "" || value === null) {
    return true
  }

  if (Array.isArray(value)) {
    return value.length === 0
  }

  if (typeof value === "object") {
    return Object.keys(value).length === 0
  }

  return false
}

function processTelemetryEventItem(event: ProcessObservabilityEvent): RuntimeTelemetryEventItem {
  const eventTime = dayjs(event.event_time)
  const time = eventTime.isValid() ? formatRecentTimestamp(event.event_time) : event.event_time

  return {
    id: event.id,
    kind: "process",
    eventTime: event.event_time,
    time,
    action: event.action,
    primary: event.process,
    secondary: event.command_invocation || event.parent_process,
    source: event.source,
    namespace: event.pod_namespace,
    pod: event.pod_name,
  }
}

function fileTelemetryEventItem(event: FileObservabilityEvent): RuntimeTelemetryEventItem {
  const eventTime = dayjs(event.event_time)
  const time = eventTime.isValid() ? formatRecentTimestamp(event.event_time) : event.event_time

  return {
    id: event.id,
    kind: "file",
    eventTime: event.event_time,
    time,
    action: event.action,
    primary: event.file_path_accessed,
    secondary: event.command_invocation || event.process,
    source: event.source,
    namespace: event.pod_namespace,
    pod: event.pod_name,
  }
}

function networkTelemetryEventItem(event: NetworkObservabilityEvent): RuntimeTelemetryEventItem {
  const eventTime = dayjs(event.event_time)
  const time = eventTime.isValid() ? formatRecentTimestamp(event.event_time) : event.event_time

  return {
    id: event.id,
    kind: "network",
    eventTime: event.event_time,
    time,
    action: event.action,
    primary: event.destination_domain || event.destination_ip,
    secondary: `${event.protocol} ${event.destination_ip}:${event.destination_port}`,
    source: event.source,
    namespace: event.pod_namespace,
    pod: event.pod_name,
  }
}

function spanDepths(spans: Span[]) {
  const byID = new Map(spans.map((span) => [span.span_id, span]))
  const depths = new Map<string, number>()

  function depth(span: Span): number {
    const cached = depths.get(span.span_id)
    if (cached !== undefined) {
      return cached
    }

    const parent = byID.get(span.parent_span_id)
    const value = parent ? Math.min(depth(parent) + 1, 4) : 0
    depths.set(span.span_id, value)

    return value
  }

  for (const span of spans) {
    depth(span)
  }

  return depths
}

function operationLabel(span: Span) {
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

function displayName(span: Span) {
  if (span.operation_name === "invoke_agent") {
    return "Agent run"
  }

  if (span.tool_name) {
    return span.tool_name
  }

  if (span.model) {
    return "Model call"
  }

  return span.name
}

function spanType(span: Span): SpanListItem["spanType"] {
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
