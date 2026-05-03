"use client"

import * as React from "react"
import { flexRender, getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Calendar,
  CircleAlert,
  Clock,
  HardDrive,
  Network,
  type LucideIcon,
  Route,
  Server,
  Wrench,
  Cpu,
  ServerCrash,
} from "lucide-react"
import {
  getRuntimeTelemetryAction,
  getRuntimeTelemetryTabAction,
  getSpanDetailAction,
  listSpansAction,
} from "@/data/lens.actions"
import type { Error } from "@/lib/gateway/client"
import type {
  ListSpansActionData,
  ListTracesActionData,
  RuntimeTelemetryActionData,
  RuntimeTelemetryEventItem,
  RuntimeTelemetryTab,
  RuntimeTelemetryTabActionData,
  SpanDetailActionData,
  SpanListItem,
  TraceListItem,
} from "@/data/types"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Button } from "@/components/ui/button"
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination"
import { Progress } from "@/components/ui/progress"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { TelemetryTableSkeleton } from "@/app/lens/runtime-telemetry/telemetry-table-skeleton"
import {
  TelemetryTable as SharedTelemetryTable,
  ActionBadge as SharedActionBadge,
  type TelemetryTableColumn,
} from "@/app/lens/runtime-telemetry/telemetry-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  formatCompactNumber,
  percentOf,
  shortLensID,
  useTokenPagination,
} from "@/app/lens/traces/client-utils"
const telemetryPageSize = 15

const columnClassName: Record<string, string> = {
  trace: "min-w-40 w-[20%]",
  duration: "min-w-52 w-[22%]",
  graph: "min-w-72 w-[36%]",
  tokens: "min-w-48 w-[22%]",
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
            {shortLensID(trace.traceId)}
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
          <MetricBadge icon={Route} value={trace.spanCount} singular="step" />
          <MetricBadge icon={Wrench} value={trace.toolCount} singular="tool call" />
          <MetricBadge icon={Brain} value={trace.modelCount} singular="model call" />
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

export function TracesTable({ data, error }: { data?: ListTracesActionData; error?: Error }) {
  "use no memo"

  const [selectedTrace, setSelectedTrace] = React.useState<TraceListItem | undefined>()
  const [spans, setSpans] = React.useState<ListSpansActionData | undefined>()
  const [telemetry, setTelemetry] = React.useState<RuntimeTelemetryActionData | undefined>()
  const [telemetryTab, setTelemetryTab] = React.useState<RuntimeTelemetryTab>("process")
  const [telemetryPages, setTelemetryPages] = React.useState<
    Partial<Record<RuntimeTelemetryTab, RuntimeTelemetryTabActionData>>
  >({})
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

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: data?.traces ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  function selectTrace(trace: TraceListItem) {
    setSelectedTrace(trace)
    setSpans(undefined)
    setTelemetry(undefined)
    setTelemetryPages({})
    setSpansError(undefined)
    setTelemetryError(undefined)
    setTab("spans")
    setTelemetryTab("process")
    setSpanPageToken(undefined)
    setSpanTokenStack([])
    setTelemetryPageToken(undefined)
    setTelemetryTokenStack([])
    startTransition(() => {
      void (async () => {
        const [spanResult, telemetryResult] = await Promise.all([
          listSpansAction({
            session_id: trace.sessionId,
            trace_id: trace.traceId,
            limit: 100,
          }),
          getRuntimeTelemetryAction({
            session_id: trace.sessionId,
            started_after: trace.startedAt,
            started_before: trace.endedAt,
          }),
        ])
        setSpans(spanResult.data)
        setSpansError(spanResult.error)
        setTelemetry(telemetryResult.data)
        setTelemetryError(telemetryResult.error)
      })()
    })
  }

  function loadTelemetryTab(
    nextTab: RuntimeTelemetryTab,
    nextPageToken?: string,
    mode: "reset" | "next" | "previous" = "reset"
  ) {
    if (!selectedTrace) {
      return
    }

    startTelemetryTransition(() => {
      void (async () => {
        const result = await getRuntimeTelemetryTabAction({
          session_id: selectedTrace.sessionId,
          started_after: selectedTrace.startedAt,
          started_before: selectedTrace.endedAt,
          tab: nextTab,
          page_token: nextPageToken,
        })
        setTelemetryPages((current) =>
          result.data ? { ...current, [nextTab]: result.data } : current
        )
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
      })()
    })
  }

  function loadSpansPage(nextPageToken?: string, mode: "next" | "previous" = "next") {
    if (!selectedTrace) {
      return
    }

    startSpansTransition(() => {
      void (async () => {
        const result = await listSpansAction({
          session_id: selectedTrace.sessionId,
          trace_id: selectedTrace.traceId,
          limit: 100,
          page_token: nextPageToken,
        })
        setSpans(result.data)
        setSpansError(result.error)
        setSelectedTrace((current) => current)
        if (mode === "next") {
          setSpanTokenStack((stack) => (spanPageToken ? [...stack, spanPageToken] : stack))
        } else {
          setSpanTokenStack((stack) => stack.slice(0, -1))
        }
        setSpanPageToken(nextPageToken)
      })()
    })
  }

  function closeTrace() {
    setSelectedTrace(undefined)
    setSpans(undefined)
    setTelemetry(undefined)
    setTelemetryPages({})
    setSpansError(undefined)
    setTelemetryError(undefined)
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/5 p-4 text-sm text-destructive">
        {error.message}
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No agents
      </div>
    )
  }

  return (
    <Sheet open={selectedTrace !== undefined} onOpenChange={(open) => !open && closeTrace()}>
      <div className="flex flex-col">
        <div className="overflow-x-auto border-b bg-background">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className={columnClassName[header.column.id]}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length > 0 ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    className="group relative border-b bg-background hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => selectTrace(row.original)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") {
                        return
                      }

                      event.preventDefault()
                      selectTrace(row.original)
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className={columnClassName[cell.column.id]}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-48 text-center text-muted-foreground"
                  >
                    No traces
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex h-12 w-full items-center gap-3 px-6">
          <span className="text-xs text-muted-foreground">{data.traces.length} rows</span>
          <TracePagination hasNextPage={data.hasNextPage} nextPageToken={data.nextPageToken} />
        </div>
      </div>
      <TraceInspector
        trace={selectedTrace}
        spans={spans}
        telemetry={telemetry}
        spansError={spansError}
        telemetryError={telemetryError}
        pending={pending}
        spansPending={spansPending}
        telemetryPending={telemetryPending}
        telemetryTab={telemetryTab}
        telemetryPage={telemetryPages[telemetryTab]}
        onTelemetryTabChange={(nextTab) => loadTelemetryTab(nextTab)}
        canGoPreviousTelemetry={telemetryTokenStack.length > 0 || telemetryPageToken !== undefined}
        onNextTelemetry={() => {
          const nextPage = telemetryPages[telemetryTab]?.nextPageToken
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
        onTabChange={setTab}
      />
    </Sheet>
  )
}

type TraceInspectorTab = "spans" | "telemetry"
type TelemetryTab = "process" | "file" | "network"

function TraceInspector({
  trace,
  spans,
  telemetry,
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
  trace?: TraceListItem
  spans?: ListSpansActionData
  telemetry?: RuntimeTelemetryActionData
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
  return (
    <SheetContent className="data-[side=right]:w-full data-[side=right]:max-w-full gap-0 overflow-y-auto overflow-x-hidden border-l bg-background p-0 text-sm shadow-2xl sm:max-w-none! md:w-[89vw]! lg:w-[84vw]! lg:overflow-hidden [&_svg]:size-4">
      <SheetHeader>
        <SheetTitle className="truncate font-mono text-md">
          {trace?.traceId ? `Trace ID: ${trace?.traceId}` : "Trace inspector"}
        </SheetTitle>
      </SheetHeader>
      <div className="flex flex-col bg-background lg:min-h-0 lg:flex-1 lg:grid lg:grid-rows-[auto_1fr]">
        <Tabs
          value={tab}
          onValueChange={(v) => onTabChange(v as TraceInspectorTab)}
          className="bg-muted/50 py-2"
        >
          <TabsList variant="line" className="gap-2">
            <TabsTrigger value="spans" className="gap-2">
              <Route /> Spans
            </TabsTrigger>
            <TabsTrigger value="telemetry" className="gap-2">
              <Server /> Runtime Telemetry
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="lg:min-h-0 lg:overflow-hidden">
          {tab === "spans" ? (
            <SpansInspectorContent
              key={trace?.traceId}
              trace={trace}
              data={spans}
              error={spansError}
              pending={pending}
              pagePending={spansPending}
              canGoPrevious={canGoPreviousSpans}
              onNextPage={onNextSpans}
              onPreviousPage={onPreviousSpans}
            />
          ) : (
            <RuntimeTelemetryContent
              key={trace?.traceId}
              data={telemetry}
              telemetryTab={telemetryTab}
              telemetryPage={telemetryPage}
              error={telemetryError}
              pending={pending}
              pagePending={telemetryPending}
              onTabChange={onTelemetryTabChange}
              canGoPrevious={canGoPreviousTelemetry}
              onNextPage={onNextTelemetry}
              onPreviousPage={onPreviousTelemetry}
            />
          )}
        </div>
      </div>
    </SheetContent>
  )
}

function SpansInspectorContent({
  trace,
  data,
  error,
  pending,
  pagePending,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
}: {
  trace?: TraceListItem
  data?: ListSpansActionData
  error?: Error
  pending: boolean
  pagePending: boolean
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
}) {
  const [selectedSpanID, setSelectedSpanID] = React.useState<string | undefined>()
  const [detailState, setDetailState] = React.useState<{
    data?: SpanDetailActionData
    error?: Error
  }>({})
  const [detailPending, startDetailTransition] = React.useTransition()
  const selectedSpan = selectedSpanID
    ? data?.spans.find((span) => span.spanId === selectedSpanID)
    : data?.spans[0]
  const { data: detail, error: detailError } = detailState

  React.useEffect(() => {
    if (!selectedSpan) {
      return
    }

    startDetailTransition(async () => {
      const result = await getSpanDetailAction({
        session_id: selectedSpan.sessionId,
        trace_id: selectedSpan.traceId,
        span_id: selectedSpan.spanId,
      })
      setDetailState({ data: result.data, error: result.error })
    })
  }, [selectedSpan])

  if (pending && !data) {
    return <InspectorSkeleton />
  }

  if (error) {
    return (
      <div className="m-6 rounded-md bg-destructive/5 p-4 text-sm text-destructive">
        {error.message}
      </div>
    )
  }

  if (!data) {
    return null
  }

  return (
    <div className="bg-background lg:h-full lg:overflow-hidden">
      <div className="flex flex-col lg:h-full lg:min-h-0 lg:grid lg:min-w-245 lg:grid-cols-[34%_66%]">
        <aside className="min-h-0 border-b bg-background lg:border-r lg:border-b-0">
          <div className="flex h-10 items-center justify-between bg-muted/10 px-4 lg:px-5">
            <div className="text-sm font-medium">Spans ({data.spans.length})</div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canGoPrevious || pagePending}
                onClick={onPreviousPage}
              >
                <ArrowLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!data.hasNextPage || pagePending}
                onClick={onNextPage}
              >
                Next
                <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
          <div className="max-h-72 overflow-auto py-2 lg:h-[calc(100vh-134px)] lg:max-h-none">
            {data.spans.length > 0 ? (
              data.spans.map((span) => (
                <SpanTreeRow
                  key={span.spanId}
                  span={span}
                  selected={selectedSpan?.spanId === span.spanId}
                  onClick={() => {
                    setSelectedSpanID(span.spanId)
                    setDetailState({})
                  }}
                />
              ))
            ) : (
              <div className="px-4 py-10 text-sm text-muted-foreground lg:px-5">No spans</div>
            )}
          </div>
        </aside>
        <section className="min-h-0 bg-background">
          <SpanDetailViewer
            trace={trace}
            span={selectedSpan}
            detail={detail}
            error={detailError}
            pending={detailPending}
          />
        </section>
      </div>
    </div>
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
  const indent = span.depth * 22 + 28

  return (
    <button
      type="button"
      className={cn(
        "relative flex w-full flex-col border-l-4 border-transparent py-1.5 pr-4 text-left hover:bg-chart-2/7 lg:pr-5",
        selected && "border-chart-2 bg-chart-2/8"
      )}
      style={{ paddingLeft: indent }}
      onClick={onClick}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn("flex size-4 shrink-0 items-center justify-center", spanColorClass(span))}
        >
          <SpanKindIcon span={span} />
        </span>
        <span className="truncate text-sm font-medium">{span.displayName}</span>
        {span.hasError ? <CircleAlert className="text-destructive" /> : null}
      </div>
      <div className="ml-6 mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground lg:gap-3 [&_svg]:size-3.5">
        <span className="inline-flex items-center gap-1">
          <Clock />
          {span.duration}
        </span>
        {span.totalTokens > 0 ? <span>{formatCompactNumber(span.totalTokens)} tokens</span> : null}
        <span className="font-mono">{shortLensID(span.spanId)}</span>
      </div>
      <div className="ml-6 mt-1.5 h-0.5 rounded-full bg-border">
        <div
          className={cn("h-full rounded-full", spanTimelineClass(span))}
          style={{
            width: `${span.durationPercent}%`,
            marginLeft: `${span.offsetPercent}%`,
          }}
        />
      </div>
    </button>
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
  const title = span?.displayName ?? (trace ? shortLensID(trace.traceId) : "Trace")

  return (
    <div className="flex flex-col lg:h-full">
      <div className="flex h-10 items-center justify-between bg-muted/10 px-4 lg:px-5 [&_svg]:size-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm text-muted-foreground">Inspect:</span>
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      </div>
      <div className="overflow-auto px-4 py-4 lg:min-h-0 lg:flex-1 lg:px-6">
        <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-muted-foreground lg:gap-4 [&_svg]:size-4">
          <span className="inline-flex items-center gap-1">
            <Calendar />
            {span?.startLabel ?? trace?.startedDate}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock />
            {span?.duration ?? trace?.duration}
          </span>
          {span?.timeToFirstToken ? <span>TTFT {span.timeToFirstToken}</span> : null}
          {span ? <span>{formatCompactNumber(span.totalTokens)} tokens</span> : null}
        </div>
        {span && span.spanType !== "agent" ? <InspectorTokenMeter span={span} /> : null}
        {error ? (
          <div className="rounded-md bg-destructive/5 p-4 text-sm text-destructive">
            {error.message}
          </div>
        ) : pending ? (
          <div className="flex flex-col gap-5">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <SpanJSONSections span={span} detail={detail} trace={trace} />
        )}
      </div>
    </div>
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
  if (!span) {
    return (
      <div className="flex flex-col gap-5">
        <JSONPanel
          title="Trace"
          rows={[
            ["trace.id", trace?.traceId ?? ""],
            ["session.id", trace?.sessionId ?? ""],
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

  const payload = detail?.payload ?? []
  const input = payload.find((section) => section.key === "input_messages")
  const output = payload.find((section) => section.key === "output_messages")
  const toolArguments = payload.find((section) => section.key === "tool_arguments")
  const toolResult = payload.find((section) => section.key === "tool_result")
  const metadata = payload.find((section) => section.key === "metadata")

  return (
    <div className="flex flex-col gap-5">
      {span.error ? (
        <JSONTextPanel title="Error" code={JSON.stringify({ error: span.error }, null, 2)} />
      ) : null}
      <JSONTextPanel title="Input" code={input?.json ?? ""} />
      <JSONTextPanel title="Output" code={output?.json ?? ""} />
      {toolArguments && !toolArguments.empty ? (
        <JSONTextPanel title="Tool arguments" code={toolArguments.json} />
      ) : null}
      {toolResult && !toolResult.empty ? (
        <JSONTextPanel title="Tool result" code={toolResult.json} />
      ) : null}
      <JSONTextPanel title="Metadata" code={metadata?.json ?? "{}"} />
      <JSONPanel
        title="Usage"
        rows={[
          ["span.id", span.spanId],
          ["parent.id", span.parentSpanId || "root"],
          ["operation", span.operationLabel],
          ["input_tokens", String(span.inputTokens)],
          ["cached_input_tokens", String(span.cachedInputTokens)],
          ["output_tokens", String(span.outputTokens)],
        ]}
      />
    </div>
  )
}

function JSONTextPanel({ title, code }: { title: string; code: string }) {
  return (
    <section>
      <div className="flex items-center justify-between my-2">
        {title === "Error" ? (
          <div className="text-sm font-medium text-destructive">
            <ServerCrash className="inline-block mr-1.5" />
            <span>{title}</span>
          </div>
        ) : (
          <div className="text-sm font-medium">{title}</div>
        )}
      </div>
      <div className="max-h-100 overflow-auto">
        <CodeBlock
          code={code}
          language="json"
          showLineNumbers={true}
          className="border-0 bg-muted/30"
        />
      </div>
    </section>
  )
}

function InspectorTokenMeter({ span }: { span: SpanListItem }) {
  if (span.totalTokens === 0) {
    return null
  }

  const uncachedInput = Math.max(span.inputTokens - span.cachedInputTokens, 0)
  const inputWidth = percentOf(uncachedInput, span.totalTokens)
  const cachedWidth = percentOf(span.cachedInputTokens, span.totalTokens)
  const outputWidth = percentOf(span.outputTokens, span.totalTokens)

  return (
    <section className="mb-5 rounded-md bg-muted/10 p-4">
      <div className="mb-3 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">
          {formatCompactNumber(span.totalTokens)} total
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="bg-chart-1" style={{ width: `${inputWidth}%` }} />
        <span className="bg-chart-3" style={{ width: `${cachedWidth}%` }} />
        <span className="bg-chart-4" style={{ width: `${outputWidth}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3 sm:gap-3">
        <TokenLegend colorClass="bg-chart-1" label="Input" value={span.inputTokens} />
        <TokenLegend colorClass="bg-chart-3" label="Cached" value={span.cachedInputTokens} />
        <TokenLegend colorClass="bg-chart-4" label="Output" value={span.outputTokens} />
      </div>
    </section>
  )
}

function TokenLegend({
  colorClass,
  label,
  value,
}: {
  colorClass: string
  label: string
  value: number
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", colorClass)} />
      <span className="truncate">
        {label} {formatCompactNumber(value)}
      </span>
    </span>
  )
}

function RuntimeTelemetryContent({
  data,
  telemetryTab,
  telemetryPage,
  error,
  pending,
  pagePending,
  onTabChange,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
}: {
  data?: RuntimeTelemetryActionData
  telemetryTab: RuntimeTelemetryTab
  telemetryPage?: RuntimeTelemetryTabActionData
  error?: Error
  pending: boolean
  pagePending: boolean
  onTabChange: (tab: RuntimeTelemetryTab) => void
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
}) {
  React.useEffect(() => {
    if (!data || telemetryPage || pagePending) {
      return
    }

    onTabChange(telemetryTab)
  }, [data, onTabChange, pagePending, telemetryPage, telemetryTab])

  if ((pending && !data) || (pagePending && !telemetryPage)) {
    return <RuntimeTelemetrySkeleton telemetryTab={telemetryTab} data={data} />
  }

  if (error) {
    return (
      <div className="m-6 rounded-md bg-destructive/5 p-4 text-sm text-destructive">
        {error.message}
      </div>
    )
  }

  if (!data) {
    return null
  }

  const processCount = data?.processCount ?? 0
  const fileCount = data?.fileCount ?? 0
  const networkCount = data?.networkCount ?? 0
  const events = telemetryPage?.events ?? []

  return (
    <Tabs
      value={telemetryTab}
      onValueChange={(v) => onTabChange(v as RuntimeTelemetryTab)}
      className="flex h-full min-h-0 flex-col mt-4"
    >
      <TabsList variant="line" className="overflow-auto overflow-y-hidden px-2">
        <TabsTrigger value="process" className="gap-2 px-4">
          <Cpu /> Process ({processCount})
        </TabsTrigger>
        <TabsTrigger value="file" className="gap-2 px-4">
          <HardDrive /> File ({fileCount})
        </TabsTrigger>
        <TabsTrigger value="network" className="gap-2 px-4">
          <Network /> Network ({networkCount})
        </TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-auto px-1 pt-4 pb-8">
        <TabsContent value="process">
          <ProcessTelemetryTable
            events={telemetryTab === "process" ? events : []}
            hasNextPage={telemetryTab === "process" ? telemetryPage?.hasNextPage : undefined}
            nextPageToken={telemetryTab === "process" ? telemetryPage?.nextPageToken : undefined}
            canGoPrevious={canGoPrevious}
            onNextPage={onNextPage}
            onPreviousPage={onPreviousPage}
            pending={pagePending}
          />
        </TabsContent>
        <TabsContent value="file">
          <FileTelemetryTable
            events={telemetryTab === "file" ? events : []}
            hasNextPage={telemetryTab === "file" ? telemetryPage?.hasNextPage : undefined}
            nextPageToken={telemetryTab === "file" ? telemetryPage?.nextPageToken : undefined}
            canGoPrevious={canGoPrevious}
            onNextPage={onNextPage}
            onPreviousPage={onPreviousPage}
            pending={pagePending}
          />
        </TabsContent>
        <TabsContent value="network">
          <NetworkTelemetryTable
            events={telemetryTab === "network" ? events : []}
            hasNextPage={telemetryTab === "network" ? telemetryPage?.hasNextPage : undefined}
            nextPageToken={telemetryTab === "network" ? telemetryPage?.nextPageToken : undefined}
            canGoPrevious={canGoPrevious}
            onNextPage={onNextPage}
            onPreviousPage={onPreviousPage}
            pending={pagePending}
          />
        </TabsContent>
      </div>
    </Tabs>
  )
}

function RuntimeTelemetrySkeleton({
  telemetryTab,
  data,
}: {
  telemetryTab: RuntimeTelemetryTab
  data?: RuntimeTelemetryActionData
}) {
  const processCount = data?.processCount ?? 0
  const fileCount = data?.fileCount ?? 0
  const networkCount = data?.networkCount ?? 0

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
    <div className="flex h-full min-h-0 flex-col mt-4">
      <Tabs value={telemetryTab} className="flex h-full min-h-0 flex-col">
        <TabsList variant="line" className="overflow-x-auto px-2">
          <TabsTrigger value="process" className="gap-2 px-4" disabled>
            <Cpu /> Process ({processCount})
          </TabsTrigger>
          <TabsTrigger value="file" className="gap-2 px-4" disabled>
            <HardDrive /> File ({fileCount})
          </TabsTrigger>
          <TabsTrigger value="network" className="gap-2 px-4" disabled>
            <Network /> Network ({networkCount})
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
          <TelemetryTableSkeleton headers={headers} rowCount={6} />
        </div>
      </Tabs>
    </div>
  )
}

function spanColorClass(span: SpanListItem) {
  if (span.spanType === "model") {
    return "text-chart-1"
  }

  if (span.spanType === "tool") {
    return "text-chart-4"
  }

  if (span.spanType === "agent") {
    return "text-primary"
  }

  return "text-chart-2"
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

const processTelemetryColumns: TelemetryTableColumn<RuntimeTelemetryEventItem>[] = [
  {
    key: "process",
    header: "Process",
    className: "min-w-36",
    render: (event) => <span className={telemetryMonoClass}>{event.primary}</span>,
  },
  {
    key: "command",
    header: "Command",
    className: "min-w-80",
    render: (event) => <span className={telemetryWideMonoClass}>{event.secondary}</span>,
  },
  {
    key: "action",
    header: "Action",
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen At",
    className: "min-w-40",
    render: (event) => <TelemetryTimestamp value={event.time} />,
  },
]

function ProcessTelemetryTable({
  events,
  hasNextPage,
  nextPageToken,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  pending,
}: {
  events: RuntimeTelemetryEventItem[]
  hasNextPage?: boolean
  nextPageToken?: string
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
  pending: boolean
}) {
  return (
    <SharedTelemetryTable
      data={events}
      columns={processTelemetryColumns}
      emptyText="No process events were recorded in this trace window."
      hasNextPage={hasNextPage}
      nextPageToken={nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={nextPageToken ? () => onNextPage() : undefined}
      onPreviousPage={onPreviousPage}
      pending={pending}
    />
  )
}

const fileTelemetryColumns: TelemetryTableColumn<RuntimeTelemetryEventItem>[] = [
  {
    key: "file",
    header: "File Path Accessed",
    className: "min-w-80",
    render: (event) => <span className={telemetryWideMonoClass}>{event.primary}</span>,
  },
  {
    key: "process",
    header: "Process",
    className: "min-w-72",
    render: (event) => <span className={telemetryWideMonoClass}>{event.secondary}</span>,
  },
  {
    key: "action",
    header: "Action",
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen At",
    className: "min-w-40",
    render: (event) => <TelemetryTimestamp value={event.time} />,
  },
]

function FileTelemetryTable({
  events,
  hasNextPage,
  nextPageToken,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  pending,
}: {
  events: RuntimeTelemetryEventItem[]
  hasNextPage?: boolean
  nextPageToken?: string
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
  pending: boolean
}) {
  return (
    <SharedTelemetryTable
      data={events}
      columns={fileTelemetryColumns}
      emptyText="No file events were recorded in this trace window."
      hasNextPage={hasNextPage}
      nextPageToken={nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={nextPageToken ? () => onNextPage() : undefined}
      onPreviousPage={onPreviousPage}
      pending={pending}
    />
  )
}

const networkTelemetryColumns: TelemetryTableColumn<RuntimeTelemetryEventItem>[] = [
  {
    key: "domain",
    header: "Destination Domain",
    className: "min-w-52",
    render: (event) => (
      <span className={telemetryMonoClass}>{networkDestinationDomain(event)}</span>
    ),
  },
  {
    key: "ip",
    header: "Destination IP",
    className: "min-w-40",
    render: (event) => <span className={telemetryMonoClass}>{networkDestinationIP(event)}</span>,
  },
  {
    key: "port",
    header: "Destination Port",
    className: "min-w-32",
    render: (event) => <span className="font-mono text-xs">{networkDestinationPort(event)}</span>,
  },
  {
    key: "protocol",
    header: "Protocol",
    className: "min-w-32",
    render: (event) => <span className={telemetryMonoClass}>{networkProtocol(event)}</span>,
  },
  {
    key: "action",
    header: "Action",
    render: (event) => <SharedActionBadge action={event.action} />,
  },
  {
    key: "time",
    header: "Seen At",
    className: "min-w-40",
    render: (event) => <TelemetryTimestamp value={event.time} />,
  },
]

function NetworkTelemetryTable({
  events,
  hasNextPage,
  nextPageToken,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  pending,
}: {
  events: RuntimeTelemetryEventItem[]
  hasNextPage?: boolean
  nextPageToken?: string
  canGoPrevious: boolean
  onNextPage: () => void
  onPreviousPage: () => void
  pending: boolean
}) {
  return (
    <SharedTelemetryTable
      data={events}
      columns={networkTelemetryColumns}
      emptyText="No network events were recorded in this trace window."
      hasNextPage={hasNextPage}
      nextPageToken={nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={nextPageToken ? () => onNextPage() : undefined}
      onPreviousPage={onPreviousPage}
      pending={pending}
    />
  )
}

function TelemetryTimestamp({ value }: { value: string }) {
  return <span className="text-sm">{value}</span>
}

const telemetryMonoClass = "max-w-[16rem] whitespace-normal break-all font-mono text-xs"
const telemetryWideMonoClass = "max-w-[28rem] whitespace-normal break-all font-mono text-xs"

function networkDestinationDomain(event: RuntimeTelemetryEventItem) {
  const domain = /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/
  if (domain.test(event.primary)) return event.primary
  return ""
}

function networkDestinationIP(event: RuntimeTelemetryEventItem) {
  if (!networkDestinationDomain(event)) {
    return event.primary
  }
  return ""
}

function networkDestinationPort(event: RuntimeTelemetryEventItem) {
  const match = event.secondary.match(/:(\d+)$/)

  return match?.[1] ?? ""
}

function networkProtocol(event: RuntimeTelemetryEventItem) {
  return event.secondary.split(" ")[0] ?? ""
}

function JSONPanel({ title, rows }: { title: string; rows: [string, string][] }) {
  return <JSONTextPanel title={title} code={JSON.stringify(Object.fromEntries(rows), null, 2)} />
}

function InspectorSkeleton() {
  return (
    <div className="grid h-full grid-cols-[360px_1fr] bg-background">
      <div className="border-r p-4">
        <Skeleton className="h-10 w-40" />
        <div className="mt-5 flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
      <div className="p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="mt-6 h-64 w-full" />
      </div>
    </div>
  )
}

function TracePagination({
  hasNextPage,
  nextPageToken,
}: {
  hasNextPage: boolean
  nextPageToken: string
}) {
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()

  return (
    <Pagination className="mx-0 ml-auto w-fit justify-end" data-pending={pending}>
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            disabled={!canGoPrevious || pending}
            onClick={goPrevious}
          >
            <ArrowLeft data-icon="inline-start" />
            Previous
          </Button>
        </PaginationItem>
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            disabled={!hasNextPage || pending}
            onClick={() => goNext(nextPageToken)}
          >
            Next
            <ArrowRight data-icon="inline-end" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
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
  return (
    <Progress
      value={trace.cumulativeDurationPercent}
      className="trace-waterfall-progress h-1.5 **:data-[slot=progress-indicator]:bg-foreground"
      style={
        {
          "--waterfall-delay": `${trace.waterfallDelayMs}ms`,
          "--waterfall-transform": `translateX(-${100 - trace.cumulativeDurationPercent}%)`,
        } as React.CSSProperties
      }
    />
  )
}
