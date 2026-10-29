"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import {
  Brain,
  CircleAlert,
  HardDrive,
  Network,
  type LucideIcon,
  Route,
  Server,
  Wrench,
  Cpu,
  MessageSquare,
} from "lucide-react"
import {
  getRuntimeTelemetryTabAction,
  getSpanDetailAction,
  listSpansAction,
} from "@/data/lens.actions"
import type {
  AppSpan,
  Span,
  Error,
  ProcessObservabilityEvent,
  FileObservabilityEvent,
  NetworkObservabilityEvent,
} from "@/lib/gateway/client"
import type {
  ListSpansActionData,
  ListTracesActionData,
  RuntimeTelemetryTab,
  RuntimeTelemetryTabActionData,
  SpanDetailActionData,
  SpanListItem,
  TraceListItem,
} from "@/data/types"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { ErrorState } from "@/components/error-state"
import { TablePagination, TokenTablePagination } from "@/components/table-pagination"
import { Progress } from "@/components/interior/progress-bar"
import { Sheet } from "@/components/ui/sheet"
import {
  TraceInspectorSheet,
  TraceInspectorSkeleton,
  TraceContentSkeleton,
  TraceInspectorLayout,
  TraceInspectorRow,
  TraceInspectorDetail,
  TraceTokenMeter,
  TraceContentPanel,
} from "@/components/trace-inspector"
import { TelemetryTableSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table-skeleton"
import {
  TelemetryTable as SharedTelemetryTable,
  ActionBadge as SharedActionBadge,
  TruncateCell,
  type TelemetryTableColumn,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatCompactNumber, formatRecentTimestamp } from "@/lib/format"
import { TraceConversation } from "./trace-conversation"

const layout: Record<string, AdminColumnLayout> = {
  trace: { minWidth: 160, contentMaxWidth: 256 },
  duration: { minWidth: 208, contentMaxWidth: 320 },
  graph: { minWidth: 288, contentMaxWidth: 448 },
  tokens: { minWidth: 192, contentMaxWidth: 288 },
}

const columns: ColumnDef<TraceListItem>[] = [
  {
    id: "trace",
    header: "Trace",
    cell: ({ row }) => {
      const trace = row.original

      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-xs font-medium text-foreground">
            {trace.traceId.slice(0, 8)}
          </span>
          <span className="text-xs text-muted-foreground">
            {trace.startedDate} · {trace.startedTime}
          </span>
        </div>
      )
    },
  },
  {
    id: "duration",
    header: "Duration",
    cell: ({ row }) => {
      const trace = row.original

      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-4">
            <span className="text-sm font-medium">{trace.duration}</span>
            <span className="text-xs text-muted-foreground">Ended {trace.endedTime}</span>
          </div>
          <WaterfallProgress trace={trace} />
        </div>
      )
    },
  },
  {
    id: "graph",
    header: "Execution",
    cell: ({ row }) => {
      const trace = row.original

      return (
        <div className="flex flex-wrap gap-1.5">
          <MetricBadge icon={Route} value={trace.spanCount} singular="span" />
          <MetricBadge icon={Wrench} value={trace.toolCount} singular="tool span" />
          <MetricBadge icon={Brain} value={trace.modelCount} singular="llm span" />
          <MetricBadge
            icon={CircleAlert}
            value={trace.errorCount}
            singular="error"
            variant={trace.errorCount > 0 ? "destructive" : "outline"}
          />
        </div>
      )
    },
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => {
      const trace = row.original
      if (trace.inputTokens === null || trace.outputTokens === null) {
        return <div aria-hidden="true" className="h-1.5 rounded-full bg-muted" />
      }
      const outputWidth = trace.totalTokens === 0 ? 0 : trace.tokenRatio * 100
      const inputWidth = trace.totalTokens === 0 ? 0 : 100 - outputWidth

      return (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{formatCompactNumber(trace.inputTokens)} in</span>
            <span>{formatCompactNumber(trace.outputTokens)} out</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <span className="h-full bg-chart-1" style={{ width: `${inputWidth}%` }} />
            <span className="h-full bg-chart-4" style={{ width: `${outputWidth}%` }} />
          </div>
          <span className="sr-only">{formatCompactNumber(trace.totalTokens)} tokens</span>
        </div>
      )
    },
  },
]

export function TracesTable({
  data,
  error,
  workspaceId,
}: {
  data?: ListTracesActionData
  error?: Error
  workspaceId: string
}) {
  "use no memo"

  const searchParams = useSearchParams()
  const initialTraceID = searchParams.get("trace_id")
  const initialTrace = data?.traces.find((trace) => trace.traceId === initialTraceID)
  const requestVersion = React.useRef(0)
  const [selectedTrace, setSelectedTrace] = React.useState<TraceListItem | undefined>(initialTrace)
  const [spans, setSpans] = React.useState<ListSpansActionData | undefined>()
  const [telemetryTab, setTelemetryTab] = React.useState<RuntimeTelemetryTab>("process")
  const [telemetryPage, setTelemetryPage] = React.useState<RuntimeTelemetryTabActionData>()
  const [spansError, setSpansError] = React.useState<Error | undefined>()
  const [telemetryError, setTelemetryError] = React.useState<Error | undefined>()
  const [tab, setTab] = React.useState<TraceInspectorTab>("spans")
  const [pending, startTransition] = React.useTransition()
  const [spansPending, startSpansTransition] = React.useTransition()
  const [telemetryPending, startTelemetryTransition] = React.useTransition()
  const [spanPageToken, setSpanPageToken] = React.useState<string | undefined>()
  const [spanTokenStack, setSpanTokenStack] = React.useState<string[]>([])
  const [telemetryPageToken, setTelemetryPageToken] = React.useState<string | undefined>()
  const [telemetryTokenStack, setTelemetryTokenStack] = React.useState<string[]>([])

  React.useEffect(() => {
    if (!initialTrace) return
    const version = ++requestVersion.current
    let cancelled = false
    startTransition(async () => {
      const result = await listSpansAction(
        { subject: initialTrace.subject, traceID: initialTrace.traceId },
        { limit: 50 },
        workspaceId
      )
      if (cancelled || version !== requestVersion.current) return
      setSpans(result.data)
      setSpansError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [initialTrace, workspaceId, startTransition])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: data?.traces ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  function selectTrace(trace: TraceListItem) {
    const version = ++requestVersion.current
    setSelectedTrace(trace)
    setSpans(undefined)
    setTelemetryPage(undefined)
    setSpansError(undefined)
    setTelemetryError(undefined)
    setTab("spans")
    setTelemetryTab("process")
    setSpanPageToken(undefined)
    setSpanTokenStack([])
    setTelemetryPageToken(undefined)
    setTelemetryTokenStack([])
    startTransition(async () => {
      const spanResult = await listSpansAction(
        {
          subject: trace.subject,
          traceID: trace.traceId,
        },
        {
          limit: 50,
        },
        workspaceId
      )
      if (version !== requestVersion.current) return
      setSpans(spanResult.data)
      setSpansError(spanResult.error)
    })
  }

  function loadTelemetryTab(
    nextTab: RuntimeTelemetryTab,
    nextPageToken?: string,
    mode: "reset" | "next" | "previous" = "reset"
  ) {
    if (!selectedTrace || selectedTrace.subject.kind !== "agent") {
      return
    }
    const version = ++requestVersion.current
    const agentName = selectedTrace.subject.name

    startTelemetryTransition(async () => {
      const result = await getRuntimeTelemetryTabAction({
        agent_name: agentName,
        started_after: selectedTrace.startedAt,
        started_before: selectedTrace.endedAt,
        tab: nextTab,
        page_token: nextPageToken,
        workspace_id: workspaceId,
      })
      if (version !== requestVersion.current) return
      setTelemetryPage(result.data)
      setTelemetryError(result.error)
      setTelemetryTab(nextTab)
      if (mode === "reset") {
        setTelemetryTokenStack([])
      }
      if (mode === "next") {
        setTelemetryTokenStack((stack) =>
          telemetryPageToken ? [...stack, telemetryPageToken] : stack
        )
      }
      if (mode === "previous") {
        setTelemetryTokenStack((stack) => stack.slice(0, -1))
      }
      setTelemetryPageToken(nextPageToken)
    })
  }

  function loadSpansPage(nextPageToken?: string, mode: "next" | "previous" = "next") {
    if (!selectedTrace) {
      return
    }

    const version = ++requestVersion.current
    startSpansTransition(async () => {
      const result = await listSpansAction(
        {
          subject: selectedTrace.subject,
          traceID: selectedTrace.traceId,
        },
        {
          limit: 50,
          page_token: nextPageToken,
        },
        workspaceId
      )
      if (version !== requestVersion.current) return
      setSpans(result.data)
      setSpansError(result.error)
      if (mode === "next") {
        setSpanTokenStack((stack) => (spanPageToken ? [...stack, spanPageToken] : stack))
      } else {
        setSpanTokenStack((stack) => stack.slice(0, -1))
      }
      setSpanPageToken(nextPageToken)
    })
  }

  function closeTrace() {
    requestVersion.current++
    setSelectedTrace(undefined)
    setSpans(undefined)
    setTelemetryPage(undefined)
    setSpansError(undefined)
    setTelemetryError(undefined)
  }

  if (error) {
    return <ErrorState error={new globalThis.Error(error.message)} />
  }

  if (!data) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No traces
      </div>
    )
  }

  return (
    <Sheet open={selectedTrace !== undefined} onOpenChange={(open) => !open && closeTrace()}>
      <div className="flex flex-col">
        <AdminDataGrid
          ariaLabel="Traces"
          emptyState={<p className="py-8 text-center text-muted-foreground">No traces found.</p>}
          layout={layout}
          onRowActivate={selectTrace}
          pagination={
            data.traces.length > 0 ? (
              <div className="flex h-12 w-full items-center gap-3 px-6">
                <span className="text-xs text-muted-foreground">{data.traces.length} rows</span>
                <TokenTablePagination
                  hasNextPage={data.hasNextPage}
                  nextPageToken={data.nextPageToken}
                />
              </div>
            ) : null
          }
          rowAriaLabel={(trace) => `View trace ${trace.traceId}`}
          rows={data.traces}
          table={table}
        />
      </div>
      <TraceInspector
        key={JSON.stringify([workspaceId, selectedTrace?.subject, selectedTrace?.traceId])}
        workspaceId={workspaceId}
        trace={selectedTrace}
        spans={spans}
        spansError={spansError}
        telemetryError={telemetryError}
        pending={pending}
        spansPending={spansPending}
        telemetryPending={telemetryPending}
        telemetryTab={telemetryTab}
        telemetryPage={telemetryPage}
        onTelemetryTabChange={(nextTab) => loadTelemetryTab(nextTab)}
        canGoPreviousTelemetry={telemetryTokenStack.length > 0 || telemetryPageToken !== undefined}
        onNextTelemetry={() => {
          const nextPage = telemetryPage?.nextPageToken
          if (nextPage) {
            loadTelemetryTab(telemetryTab, nextPage, "next")
          }
        }}
        onPreviousTelemetry={() =>
          loadTelemetryTab(telemetryTab, telemetryTokenStack.at(-1), "previous")
        }
        canGoPreviousSpans={spanTokenStack.length > 0 || spanPageToken !== undefined}
        onNextSpans={() => spans?.nextPageToken && loadSpansPage(spans.nextPageToken, "next")}
        onPreviousSpans={() => loadSpansPage(spanTokenStack.at(-1), "previous")}
        tab={tab}
        onTabChange={(nextTab) => {
          setTab(nextTab)
          if (nextTab === "spans" && !spans) loadSpansPage()
          if (nextTab === "telemetry" && !telemetryPage) {
            loadTelemetryTab(telemetryTab)
          }
        }}
      />
    </Sheet>
  )
}

type TraceInspectorTab = "conversation" | "spans" | "telemetry"

function TraceInspector({
  workspaceId,
  trace,
  spans,
  spansError,
  telemetryError,
  pending,
  spansPending,
  telemetryPending,
  telemetryTab,
  telemetryPage,
  onTelemetryTabChange,
  canGoPreviousTelemetry,
  onNextTelemetry,
  onPreviousTelemetry,
  canGoPreviousSpans,
  onNextSpans,
  onPreviousSpans,
  tab,
  onTabChange,
}: {
  workspaceId: string
  trace?: TraceListItem
  spans?: ListSpansActionData
  spansError?: Error
  telemetryError?: Error
  pending: boolean
  spansPending: boolean
  telemetryPending: boolean
  telemetryTab: RuntimeTelemetryTab
  telemetryPage?: RuntimeTelemetryTabActionData
  onTelemetryTabChange: (tab: RuntimeTelemetryTab) => void
  canGoPreviousTelemetry: boolean
  onNextTelemetry: () => void
  onPreviousTelemetry: () => void
  canGoPreviousSpans: boolean
  onNextSpans: () => void
  onPreviousSpans: () => void
  tab: TraceInspectorTab
  onTabChange: (tab: TraceInspectorTab) => void
}) {
  const [focusedDetail, setFocusedDetail] = React.useState<SpanDetailActionData>()
  const [focusError, setFocusError] = React.useState<Error>()
  const [, startInspectTransition] = React.useTransition()
  const searchParams = useSearchParams()
  const focusedSpanID = searchParams.get("span_id")
  const focusedTraceID = searchParams.get("trace_id")
  const operationID = Number(searchParams.get("operation_id"))

  React.useEffect(() => {
    if (
      !trace ||
      trace.traceId !== focusedTraceID ||
      !focusedSpanID ||
      !Number.isSafeInteger(operationID) ||
      operationID < 1
    )
      return
    let cancelled = false
    startInspectTransition(async () => {
      const result = await getSpanDetailAction(
        { subject: trace.subject, traceID: trace.traceId, spanID: focusedSpanID, operationID },
        workspaceId
      )
      if (cancelled) return
      setFocusedDetail(result.data)
      setFocusError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [trace, focusedTraceID, focusedSpanID, operationID, workspaceId, startInspectTransition])

  function inspect(span: AppSpan | Span) {
    if (!trace) return
    startInspectTransition(async () => {
      const result = await getSpanDetailAction(
        {
          subject: trace.subject,
          traceID: span.trace_id,
          spanID: span.span_id,
          operationID: span.id,
        },
        workspaceId
      )
      setFocusError(result.error)
      if (!result.data) return
      setFocusedDetail(result.data)
      onTabChange("spans")
    })
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "conversation" || value === "spans" || value === "telemetry")
          onTabChange(value)
      }}
    >
      <TraceInspectorSheet
        title={
          <span className="font-mono">
            {trace?.traceId ? `Trace ID: ${trace.traceId}` : "Trace inspector"}
          </span>
        }
        tabs={
          <TabsList className="gap-2">
            {trace ? (
              <TabsTrigger value="conversation" className="gap-2">
                <MessageSquare /> Conversation
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="spans" className="gap-2">
              <Route /> Spans
            </TabsTrigger>
            {trace?.subject.kind === "agent" ? (
              <TabsTrigger value="telemetry" className="gap-2">
                <Server /> Runtime Telemetry
              </TabsTrigger>
            ) : null}
          </TabsList>
        }
      >
        {focusError ? (
          <Alert variant="destructive">
            <AlertDescription>{focusError.message}</AlertDescription>
          </Alert>
        ) : null}
        {trace ? (
          <TabsContent value="conversation" className="m-0 h-full min-h-0">
            <TraceConversation trace={trace} workspaceId={workspaceId} onInspect={inspect} />
          </TabsContent>
        ) : null}
        <TabsContent value="spans" className="m-0 h-full min-h-0">
          <SpansInspectorContent
            workspaceId={workspaceId}
            key={trace?.traceId}
            trace={trace}
            data={spans}
            error={spansError}
            pending={pending}
            pagePending={spansPending}
            canGoPrevious={canGoPreviousSpans}
            onNextPage={onNextSpans}
            onPreviousPage={onPreviousSpans}
            focusedDetail={focusedDetail}
          />
        </TabsContent>
        <TabsContent value="telemetry" className="m-0 h-full min-h-0">
          <RuntimeTelemetryContent
            key={trace?.traceId}
            telemetryTab={telemetryTab}
            telemetryPage={telemetryPage}
            error={telemetryError}
            pagePending={telemetryPending}
            onTabChange={onTelemetryTabChange}
            canGoPrevious={canGoPreviousTelemetry}
            onNextPage={onNextTelemetry}
            onPreviousPage={onPreviousTelemetry}
          />
        </TabsContent>
      </TraceInspectorSheet>
    </Tabs>
  )
}

function SpansInspectorContent({
  workspaceId,
  trace,
  data,
  error,
  pending,
  pagePending,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  focusedDetail,
}: {
  workspaceId: string
  trace?: TraceListItem
  data?: ListSpansActionData
  error?: Error
  pending: boolean
  pagePending: boolean
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
  focusedDetail?: SpanDetailActionData
}) {
  const [selectedOperationID, setSelectedOperationID] = React.useState<number | undefined>()
  const [detailState, setDetailState] = React.useState<{
    operationID?: number
    data?: SpanDetailActionData
    error?: Error
  }>({})
  const [detailPending, startDetailTransition] = React.useTransition()
  const selectedID = selectedOperationID ?? focusedDetail?.span.id
  let selectedSpan = data?.spans.find((span) => span.id === selectedID)
  if (!selectedSpan && focusedDetail && focusedDetail.span.id === selectedID)
    selectedSpan = focusedDetail.span
  selectedSpan ??= data?.spans[0]
  let detail = focusedDetail?.span.id === selectedSpan?.id ? focusedDetail : undefined
  if (detailState.operationID === selectedSpan?.id) detail = detailState.data
  const detailError = detailState.operationID === selectedSpan?.id ? detailState.error : undefined

  React.useEffect(() => {
    if (!selectedSpan) {
      return
    }
    if (focusedDetail?.span.id === selectedSpan.id) return

    let cancelled = false

    startDetailTransition(async () => {
      const result = await getSpanDetailAction(
        {
          subject: selectedSpan.subject,
          operationID: selectedSpan.id,
          traceID: selectedSpan.traceId,
          spanID: selectedSpan.spanId,
        },
        workspaceId
      )
      if (!cancelled) {
        setDetailState({
          operationID: selectedSpan.id,
          data: result.data,
          error: result.error,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [selectedSpan, focusedDetail, startDetailTransition, workspaceId])

  if ((pending || pagePending) && !data) {
    return <TraceInspectorSkeleton />
  }

  if (error) {
    return (
      <Alert className="px-6" variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (!data) {
    return null
  }
  const offPageSpan = focusedDetail?.span
  const sourceOffPage = offPageSpan && !data.spans.some((span) => span.id === offPageSpan.id)

  return (
    <TraceInspectorLayout
      title="Spans"
      pagination={
        <TablePagination
          canGoNext={data.hasNextPage}
          canGoPrevious={canGoPrevious}
          goNext={onNextPage}
          goPrevious={onPreviousPage}
          pending={pagePending}
        />
      }
      navigation={
        <>
          {sourceOffPage ? (
            <div className="mb-2 border-b pb-2">
              <p className="px-4 py-2 text-xs text-muted-foreground lg:px-5">
                Selected from conversation
              </p>
              <SpanTreeRow
                span={offPageSpan}
                selected={selectedSpan?.id === offPageSpan.id}
                onClick={() => setSelectedOperationID(offPageSpan.id)}
              />
            </div>
          ) : null}
          {data.spans.length > 0 ? (
            data.spans.map((span) => (
              <SpanTreeRow
                key={span.id}
                span={span}
                selected={selectedSpan?.id === span.id}
                onClick={() => {
                  if (selectedSpan?.id === span.id) {
                    return
                  }

                  setSelectedOperationID(span.id)
                  setDetailState({})
                }}
              />
            ))
          ) : (
            <div className="px-4 py-10 text-sm text-muted-foreground lg:px-5">No spans</div>
          )}
        </>
      }
    >
      <SpanDetailViewer
        trace={trace}
        span={selectedSpan}
        detail={detail}
        error={detailError}
        pending={detailPending}
      />
    </TraceInspectorLayout>
  )
}

function SpanTreeRow({
  span,
  selected,
  onClick,
}: {
  span: SpanListItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <TraceInspectorRow
      label={span.displayName}
      icon={<SpanKindIcon span={span} />}
      selected={selected}
      onClick={onClick}
      depth={span.depth}
      duration={span.duration}
      tokens={span.totalTokens ?? undefined}
      id={span.spanId}
      hasError={span.hasError}
      timelineClass={spanTimelineClass(span)}
      durationPercent={span.durationPercent}
      offsetPercent={span.offsetPercent}
    />
  )
}

function SpanKindIcon({ span }: { span: SpanListItem }) {
  if (span.spanType === "model") {
    return <Brain className="size-4" />
  }

  if (span.spanType === "tool") {
    return <Wrench className="size-4" />
  }

  return <Route className="size-4" />
}

function SpanDetailViewer({
  trace,
  span,
  detail,
  error,
  pending,
}: {
  trace?: TraceListItem
  span?: SpanListItem
  detail?: SpanDetailActionData
  error?: Error
  pending: boolean
}) {
  const title = span?.displayName ?? (trace ? trace.traceId.slice(0, 8) : "Trace")

  return (
    <TraceInspectorDetail
      title={title}
      started={span?.startLabel ?? trace?.startedDate}
      duration={span ? span.duration : trace?.duration}
      tokens={span?.totalTokens ?? undefined}
    >
      {span &&
      span.spanType !== "agent" &&
      span.inputTokens !== null &&
      span.outputTokens !== null ? (
        <TraceTokenMeter
          segments={[
            {
              label: "Input",
              value: Math.max(span.inputTokens - (span.cachedInputTokens ?? 0), 0),
              displayValue: span.inputTokens,
              colorClass: "bg-chart-1",
            },
            ...(span.cachedInputTokens === null
              ? []
              : [{ label: "Cached", value: span.cachedInputTokens, colorClass: "bg-chart-3" }]),
            { label: "Output", value: span.outputTokens, colorClass: "bg-chart-4" },
          ]}
        />
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : pending ? (
        <TraceContentSkeleton />
      ) : (
        <SpanJSONSections span={span} detail={detail} trace={trace} />
      )}
    </TraceInspectorDetail>
  )
}

function SpanJSONSections({
  span,
  detail,
  trace,
}: {
  span?: SpanListItem
  detail?: SpanDetailActionData
  trace?: TraceListItem
}) {
  const searchParams = useSearchParams()
  const focusedSection =
    searchParams.get("span_id") === span?.spanId ? searchParams.get("section") : null
  React.useEffect(() => {
    if (!focusedSection || !detail) return
    const frame = requestAnimationFrame(() => {
      const panel = document.getElementById(`trace-payload-${focusedSection}`)
      panel?.scrollIntoView({ block: "start", behavior: "instant" })
      panel?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedSection, detail])
  if (!span) {
    return (
      <div className="flex flex-col gap-5">
        <JSONPanel
          title="Trace"
          rows={[
            ["trace.id", trace?.traceId ?? ""],
            [trace?.subject.kind === "app" ? "app.name" : "agent.name", trace?.subject.name ?? ""],
            ["duration", trace?.duration ?? ""],
            ["spans", String(trace?.spanCount ?? 0)],
            ["tools", String(trace?.toolCount ?? 0)],
            ["models", String(trace?.modelCount ?? 0)],
            ["errors", String(trace?.errorCount ?? 0)],
          ]}
        />
      </div>
    )
  }

  const rows: [string, string][] = [
    [span.subject.kind === "app" ? "app.name" : "agent.name", span.subject.name],
    ["span.id", span.spanId],
    ["parent.id", span.parentSpanId || "root"],
    ["span.class", span.spanClass],
    ["kind", span.kind],
    ["status_code", span.statusCode],
    ["operation", span.displayName],
  ]
  const usage = [
    ["input_tokens", span.inputTokens],
    ["cached_input_tokens", span.cachedInputTokens],
    ["cached_write_tokens", span.cachedWriteTokens],
    ["output_tokens", span.outputTokens],
  ] as const
  for (const [name, value] of usage) {
    if (value !== null) rows.push([name, String(value)])
  }
  if (span.subject.kind === "agent") {
    rows.push(
      ["session.id", span.subject.sessionId],
      ["llm_finish_reason", span.llmFinishReason || ""]
    )
  } else {
    rows.push(["app.client_id", span.subject.clientID])
  }

  return (
    <div className="flex flex-col gap-5">
      {span.error ? (
        <TraceContentPanel title="Error" code={JSON.stringify({ error: span.error }, null, 2)} />
      ) : null}
      {detail?.payload.map((section) =>
        section.empty ? null : (
          <div
            key={section.key}
            id={`trace-payload-${section.key}`}
            tabIndex={-1}
            data-focused={focusedSection === section.key}
            className="scroll-mt-4 rounded-lg outline-none data-[focused=true]:border-2 data-[focused=true]:border-dashed data-[focused=true]:border-primary/40 data-[focused=true]:p-3"
          >
            <TraceContentPanel title={section.label} {...section.content} />
          </div>
        )
      )}
      <JSONPanel title="Usage" rows={rows} />
    </div>
  )
}

function RuntimeTelemetryContent({
  telemetryTab,
  telemetryPage,
  error,
  pagePending,
  onTabChange,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
}: {
  telemetryTab: RuntimeTelemetryTab
  telemetryPage?: RuntimeTelemetryTabActionData
  error?: Error
  pagePending: boolean
  onTabChange: (tab: RuntimeTelemetryTab) => void
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
}) {
  if (pagePending && !telemetryPage) {
    return <RuntimeTelemetrySkeleton telemetryTab={telemetryTab} />
  }

  if (error) {
    return (
      <Alert className="px-6" variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (!telemetryPage) {
    return null
  }

  const pagination = {
    hasNextPage: telemetryPage.hasNextPage,
    nextPageToken: telemetryPage.nextPageToken,
    canGoPrevious,
    onNextPage,
    onPreviousPage,
    pending: pagePending,
  }

  return (
    <Tabs
      value={telemetryTab}
      onValueChange={(value) => {
        if (value === "process" || value === "file" || value === "network") {
          onTabChange(value)
        }
      }}
      className="mt-4 flex h-full min-h-0 flex-col"
    >
      <TabsList className="overflow-auto overflow-y-hidden px-2">
        <TabsTrigger value="process" className="gap-2 px-4">
          <Cpu /> Process
        </TabsTrigger>
        <TabsTrigger value="file" className="gap-2 px-4">
          <HardDrive /> File
        </TabsTrigger>
        <TabsTrigger value="network" className="gap-2 px-4">
          <Network /> Network
        </TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-auto px-1 pt-4 pb-8">
        <TabsContent value="process">
          {telemetryPage.tab === "process" ? (
            <SharedTelemetryTable
              data={telemetryPage.events}
              columns={processTelemetryColumns}
              emptyText="No process events were recorded in this trace window."
              {...pagination}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="file">
          {telemetryPage.tab === "file" ? (
            <SharedTelemetryTable
              data={telemetryPage.events}
              columns={fileTelemetryColumns}
              emptyText="No file events were recorded in this trace window."
              {...pagination}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="network">
          {telemetryPage.tab === "network" ? (
            <SharedTelemetryTable
              data={telemetryPage.events}
              columns={networkTelemetryColumns}
              emptyText="No network events were recorded in this trace window."
              {...pagination}
            />
          ) : null}
        </TabsContent>
      </div>
    </Tabs>
  )
}

function RuntimeTelemetrySkeleton({ telemetryTab }: { telemetryTab: RuntimeTelemetryTab }) {
  const headers =
    telemetryTab === "process"
      ? ["Process", "Command", "Action", "Seen At"]
      : telemetryTab === "file"
        ? ["File Path Accessed", "Process", "Action", "Seen At"]
        : [
            "Destination Domain",
            "Destination IP",
            "Destination Port",
            "Protocol",
            "Action",
            "Seen At",
          ]

  return (
    <div className="mt-4 flex h-full min-h-0 flex-col">
      <Tabs value={telemetryTab} className="flex h-full min-h-0 flex-col">
        <TabsList className="overflow-x-auto px-2">
          <TabsTrigger value="process" className="gap-2 px-4" disabled>
            <Cpu /> Process
          </TabsTrigger>
          <TabsTrigger value="file" className="gap-2 px-4" disabled>
            <HardDrive /> File
          </TabsTrigger>
          <TabsTrigger value="network" className="gap-2 px-4" disabled>
            <Network /> Network
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
          <TelemetryTableSkeleton headers={headers} rowCount={6} />
        </div>
      </Tabs>
    </div>
  )
}

function spanTimelineClass(span: SpanListItem) {
  if (span.spanType === "model") {
    return "bg-chart-1"
  }

  if (span.spanType === "tool") {
    return "bg-chart-4"
  }

  if (span.spanType === "agent") {
    return "bg-primary"
  }

  return "bg-chart-2"
}

const processTelemetryColumns: TelemetryTableColumn<ProcessObservabilityEvent>[] = [
  {
    key: "process",
    header: "Process",
    layout: { minWidth: 144, contentMaxWidth: 256 },
    render: (event) => <TruncateCell value={event.process} />,
  },
  {
    key: "command",
    header: "Command",
    layout: { minWidth: 320, contentMaxWidth: 448 },
    render: (event) => <TruncateCell value={event.command_invocation || event.parent_process} />,
  },
  {
    key: "action",
    header: "Action",
    layout: { minWidth: 112, width: 112 },
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen at",
    layout: { minWidth: 160, width: 160 },
    render: (event) => (
      <span className="text-sm text-muted-foreground">
        {formatRecentTimestamp(event.event_time)}
      </span>
    ),
  },
]

const fileTelemetryColumns: TelemetryTableColumn<FileObservabilityEvent>[] = [
  {
    key: "file",
    header: "File path accessed",
    layout: { minWidth: 320, contentMaxWidth: 448 },
    render: (event) => <TruncateCell value={event.file_path_accessed} />,
  },
  {
    key: "process",
    header: "Process",
    layout: { minWidth: 288, contentMaxWidth: 448 },
    render: (event) => <TruncateCell value={event.command_invocation || event.process} />,
  },
  {
    key: "action",
    header: "Action",
    layout: { minWidth: 112, width: 112 },
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen at",
    layout: { minWidth: 160, width: 160 },
    render: (event) => (
      <span className="text-sm text-muted-foreground">
        {formatRecentTimestamp(event.event_time)}
      </span>
    ),
  },
]

const networkTelemetryColumns: TelemetryTableColumn<NetworkObservabilityEvent>[] = [
  {
    key: "domain",
    header: "Destination domain",
    layout: { minWidth: 208, contentMaxWidth: 320 },
    render: (event) => <TruncateCell value={event.destination_domain} />,
  },
  {
    key: "ip",
    header: "Destination IP",
    layout: { minWidth: 160, width: 160 },
    render: (event) => <TruncateCell value={event.destination_ip} />,
  },
  {
    key: "port",
    header: "Destination port",
    layout: { minWidth: 128, width: 128 },
    render: (event) => <TruncateCell value={event.destination_port.toString()} />,
  },
  {
    key: "protocol",
    header: "Protocol",
    layout: { minWidth: 128, width: 128 },
    render: (event) => <TruncateCell value={event.protocol} />,
  },
  {
    key: "action",
    header: "Action",
    layout: { minWidth: 112, width: 112 },
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen at",
    layout: { minWidth: 160, width: 160 },
    render: (event) => (
      <span className="text-sm text-muted-foreground">
        {formatRecentTimestamp(event.event_time)}
      </span>
    ),
  },
]

function JSONPanel({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <TraceContentPanel title={title} code={JSON.stringify(Object.fromEntries(rows), null, 2)} />
  )
}

function MetricBadge({
  icon: Icon,
  value,
  singular,
  variant = "outline",
}: {
  icon: LucideIcon
  value: number
  singular: string
  variant?: React.ComponentProps<typeof Badge>["variant"]
}) {
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" />
      {formatCompactNumber(value)} {value === 1 ? singular : `${singular}s`}
    </Badge>
  )
}

function WaterfallProgress({ trace }: { trace: TraceListItem }) {
  const style: React.CSSProperties & {
    "--waterfall-delay": string
    "--waterfall-transform": string
  } = {
    "--waterfall-delay": `${trace.waterfallDelayMs}ms`,
    "--waterfall-transform": `translateX(-${100 - trace.cumulativeDurationPercent}%)`,
  }

  return (
    <Progress
      value={trace.cumulativeDurationPercent}
      className="trace-waterfall-progress h-1.5 **:data-[slot=progress-indicator]:bg-foreground"
      style={style}
    />
  )
}
