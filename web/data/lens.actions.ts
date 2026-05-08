"use server"

import {
  getSpanDetail,
  listFileObservability,
  listNetworkObservability,
  listProcessObservability,
  listSpans,
  listTraces,
  type ProcessObservabilityEventAggregated,
  type FileObservabilityEventAggregated,
  type NetworkObservabilityEventAggregated,
  type ProcessObservabilityEvent,
  type FileObservabilityEvent,
  type NetworkObservabilityEvent,
  type GetSpanDetailData,
  type JsonValue,
  type ListSpansData,
  type ListTracesData,
  type Span,
  type SpanPayload,
  type Trace,
} from "@/lib/gateway/client"
import type {
  FileTelemetryActionResponse,
  FileTelemetryRow,
  ListSpansActionResponse,
  ListTracesActionResponse,
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
  TraceChartActionData,
  TraceChartActionResponse,
  TraceChartPoint,
  TraceListItem,
} from "@/data/types"
import { dayjs } from "@/lib/dayjs"

const maxChartPoints = 25
const chartSourceLimit = 100
type DayjsDate = ReturnType<typeof dayjs>
type AggregatedTelemetryEvent = {
  last_seen: string
  occurrences: number
}

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

export async function listSpansAction(
  query: ListSpansData["query"]
): Promise<ListSpansActionResponse> {
  const result = await listSpans({ query })
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
  query: GetSpanDetailData["query"]
): Promise<SpanDetailActionResponse> {
  const result = await getSpanDetail({ query })
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
    },
    error: undefined,
  }
}

export async function getRuntimeTelemetryAction({
  session_id,
  started_after,
  started_before,
}: {
  session_id: string
  started_after: string
  started_before: string
}): Promise<RuntimeTelemetryActionResponse> {
  const query = {
    session_id,
    limit: 25,
    aggregated: false,
    event_time_after: isoDateTimeParam(started_after),
    event_time_before: isoDateTimeParam(started_before),
  }
  const [processes, files, networks] = await Promise.all([
    listProcessObservability({ query }),
    listFileObservability({ query }),
    listNetworkObservability({ query }),
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
    ...(processes.data.events as ProcessObservabilityEvent[]).map(processTelemetryEventItem),
    ...(files.data.events as FileObservabilityEvent[]).map(fileTelemetryEventItem),
    ...(networks.data.events as NetworkObservabilityEvent[]).map(networkTelemetryEventItem),
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
  session_id,
  started_after,
  started_before,
  tab,
  page_token,
}: {
  session_id: string
  started_after: string
  started_before: string
  tab: RuntimeTelemetryTab
  page_token?: string
}): Promise<RuntimeTelemetryTabActionResponse> {
  const query = {
    session_id,
    limit: 25,
    page_token: page_token ?? undefined,
    aggregated: false,
    event_time_after: isoDateTimeParam(started_after),
    event_time_before: isoDateTimeParam(started_before),
  }

  if (tab === "process") {
    const result = await listProcessObservability({ query })
    if (result.error) {
      return { data: undefined, error: result.error }
    }

    const events = (result.data.events as ProcessObservabilityEvent[]).map(
      processTelemetryEventItem
    )
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
    const result = await listFileObservability({ query })
    if (result.error) {
      return { data: undefined, error: result.error }
    }

    const events = (result.data.events as FileObservabilityEvent[]).map(fileTelemetryEventItem)
    return {
      data: {
        events,
        nextPageToken: result.data.next_page_token,
        hasNextPage: result.data.next_page_token.length > 0,
      },
      error: undefined,
    }
  }

  const result = await listNetworkObservability({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = (result.data.events as NetworkObservabilityEvent[]).map(networkTelemetryEventItem)
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
const defaultPageSize = 50

function rowTelemetryEvent(event: ProcessObservabilityEventAggregated): ProcessTelemetryRow {
  return {
    process: event.process,
    command: event.command_invocation || event.parent_process,
    action: event.action,
    occurrences: Number(event.occurrences),
    lastSeen: formatEventTime(event.last_seen),
  }
}

function fileTelemetryEvent(event: FileObservabilityEventAggregated): FileTelemetryRow {
  return {
    filePath: event.file_path_accessed,
    process: event.command_invocation || event.process,
    action: event.action,
    occurrences: Number(event.occurrences),
    lastSeen: formatEventTime(event.last_seen),
  }
}

function networkTelemetryEvent(event: NetworkObservabilityEventAggregated): NetworkTelemetryRow {
  return {
    destinationDomain: event.destination_domain || "",
    destinationIP: event.destination_ip,
    destinationPort: event.destination_port,
    protocol: event.protocol,
    action: event.action,
    occurrences: Number(event.occurrences),
    lastSeen: formatEventTime(event.last_seen),
  }
}

function computeTelemetryChartFromAggregated(
  events: AggregatedTelemetryEvent[]
): TraceChartActionData {
  if (events.length === 0) {
    return { points: [], total: 0, granularity: "no data" }
  }

  const eventTimes = events.map((e) => dayjs(e.last_seen))
  const minTime = eventTimes.reduce((min, t) => (t.isBefore(min) ? t : min), eventTimes[0])
  const maxTime = eventTimes.reduce((max, t) => (t.isAfter(max) ? t : max), eventTimes[0])

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
          startedAfter: from.toISOString(),
          startedBefore: to.toISOString(),
        },
      ],
      total: events.length,
      granularity: "single point",
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
        startedAfter: bucketStart.toISOString(),
        startedBefore: bucketEnd.toISOString(),
      }
    })
    .filter((p) => p.count > 0)

  return {
    points,
    total: events.reduce((sum, e) => sum + Number(e.occurrences), 0),
    granularity: points.length === 1 ? "single bucket" : `${points.length} buckets`,
  }
}

export async function getProcessTelemetryAction({
  session_id,
  event_time_after,
  event_time_before,
  page_token,
}: {
  session_id: string
  event_time_after?: string
  event_time_before?: string
  page_token?: string
}): Promise<ProcessTelemetryActionResponse> {
  const query = {
    session_id,
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    aggregated: true,
    event_time_after: event_time_after ? isoDateTimeParam(event_time_after) : undefined,
    event_time_before: event_time_before ? isoDateTimeParam(event_time_before) : undefined,
  }

  const result = await listProcessObservability({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events as ProcessObservabilityEventAggregated[]
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
  session_id,
  event_time_after,
  event_time_before,
  page_token,
}: {
  session_id: string
  event_time_after?: string
  event_time_before?: string
  page_token?: string
}): Promise<FileTelemetryActionResponse> {
  const query = {
    session_id,
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    aggregated: true,
    event_time_after: event_time_after ? isoDateTimeParam(event_time_after) : undefined,
    event_time_before: event_time_before ? isoDateTimeParam(event_time_before) : undefined,
  }

  const result = await listFileObservability({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events as FileObservabilityEventAggregated[]
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
  session_id,
  event_time_after,
  event_time_before,
  page_token,
}: {
  session_id: string
  event_time_after?: string
  event_time_before?: string
  page_token?: string
}): Promise<NetworkTelemetryActionResponse> {
  const query = {
    session_id,
    limit: defaultPageSize,
    page_token: page_token ?? undefined,
    aggregated: true,
    event_time_after: event_time_after ? isoDateTimeParam(event_time_after) : undefined,
    event_time_before: event_time_before ? isoDateTimeParam(event_time_before) : undefined,
  }

  const result = await listNetworkObservability({ query })
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const events = result.data.events as NetworkObservabilityEventAggregated[]
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

function formatEventTime(eventTime: string): string {
  const parsed = dayjs(eventTime)
  if (!parsed.isValid()) {
    return eventTime
  }

  if (dayjs().diff(parsed, "hour", true) < 48) {
    return parsed.fromNow()
  }

  return parsed.format("MMM D, YYYY, h:mm A")
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
  const startedAt = dayjs(trace.started_at)
  const endedAt = dayjs(trace.ended_at)
  const totalTokens = trace.input_tokens + trace.output_tokens
  const durationMs = trace.duration_ns / 1_000_000
  const startedDate = !startedAt.isValid()
    ? trace.started_at
    : dayjs().diff(startedAt, "hour", true) < 48
      ? startedAt.fromNow()
      : startedAt.format("MMM D, YYYY")
  const startedTime = startedAt.isValid() ? startedAt.format("h:mm A") : trace.started_at
  const endedTime = endedAt.isValid() ? endedAt.format("h:mm A") : trace.ended_at

  return {
    traceId: trace.trace_id,
    sessionId: trace.session_id,
    startedAt: trace.started_at,
    endedAt: trace.ended_at,
    startedDate,
    startedTime,
    endedTime,
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
  const startTime = dayjs(span.start_time)
  const endTime = dayjs(span.end_time)
  const totalTokens = span.input_tokens + span.output_tokens
  const hasError =
    span.status_code === "ERROR" || span.error_type.length > 0 || span.error_message.length > 0
  const startLabel = !startTime.isValid()
    ? span.start_time
    : dayjs().diff(startTime, "hour", true) < 48
      ? startTime.fromNow()
      : startTime.format("MMM D, YYYY, h:mm A")
  const endLabel = !endTime.isValid()
    ? span.end_time
    : dayjs().diff(endTime, "hour", true) < 48
      ? endTime.fromNow()
      : endTime.format("MMM D, YYYY, h:mm A")

  return {
    id: span.id,
    sessionId: span.session_id,
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    startLabel,
    endLabel,
    duration: formatDuration(durationMs),
    durationMs,
    displayName: displayName(span),
    operationLabel: operationLabel(span),
    hasError,
    error: span.error_message,
    timeToFirstToken:
      span.time_to_first_token_ms > 0 ? formatDuration(span.time_to_first_token_ms) : "",
    spanType: spanType(span),
    depth,
    inputTokens: span.input_tokens,
    cachedInputTokens: span.cached_input_tokens,
    outputTokens: span.output_tokens,
    totalTokens,
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
    payloadSection("metadata", "Metadata", payload.metadata),
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
  const time = !eventTime.isValid()
    ? event.event_time
    : dayjs().diff(eventTime, "hour", true) < 48
      ? eventTime.fromNow()
      : eventTime.format("MMM D, YYYY, h:mm A")

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
  const time = !eventTime.isValid()
    ? event.event_time
    : dayjs().diff(eventTime, "hour", true) < 48
      ? eventTime.fromNow()
      : eventTime.format("MMM D, YYYY, h:mm A")

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
  const time = !eventTime.isValid()
    ? event.event_time
    : dayjs().diff(eventTime, "hour", true) < 48
      ? eventTime.fromNow()
      : eventTime.format("MMM D, YYYY, h:mm A")

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
    return titleLabel(span.tool_name)
  }

  if (span.model) {
    return "Model call"
  }

  return titleLabel(span.operation_name || span.name)
}

function displayName(span: Span) {
  if (span.operation_name === "invoke_agent") {
    return "Agent run"
  }

  if (span.tool_name) {
    return titleLabel(span.tool_name)
  }

  if (span.model) {
    return "Model call"
  }

  return titleLabel(span.name)
}

function titleLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
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

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`
  }

  return `${dayjs.duration(durationMs).asSeconds().toFixed(2)} s`
}
