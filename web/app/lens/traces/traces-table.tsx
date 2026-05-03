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
  getSpanDetailAction,
  listSpansAction,
} from "@/data/lens.actions"
import type { Error } from "@/lib/gateway/client"
import type {
  ListSpansActionData,
  ListTracesActionData,
  RuntimeTelemetryActionData,
  RuntimeTelemetryEventItem,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
            {shortTraceID(trace.traceId)}
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
            <span>{formatNumber(trace.inputTokens)} in</span>
            <span>{formatNumber(trace.outputTokens)} out</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <span className="h-full bg-emerald-500" style={{ width: `${inputWidth}%` }} />
            <span className="h-full bg-blue-500" style={{ width: `${outputWidth}%` }} />
          </div>
          <span className="sr-only">{formatNumber(trace.totalTokens)} tokens</span>
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
  const [spansError, setSpansError] = React.useState<Error | undefined>()
  const [telemetryError, setTelemetryError] = React.useState<Error | undefined>()
  const [tab, setTab] = React.useState<TraceInspectorTab>("spans")
  const [pending, startTransition] = React.useTransition()

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
    setSpansError(undefined)
    setTelemetryError(undefined)
    setTab("spans")
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

  function closeTrace() {
    setSelectedTrace(undefined)
    setSpans(undefined)
    setTelemetry(undefined)
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
  tab,
  onTabChange,
}: {
  trace?: TraceListItem
  spans?: ListSpansActionData
  telemetry?: RuntimeTelemetryActionData
  spansError?: Error
  telemetryError?: Error
  pending: boolean
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
        <TraceInspectorTabs value={tab} onValueChange={onTabChange} />
        <div className="lg:min-h-0 lg:overflow-hidden">
          {tab === "spans" ? (
            <SpansInspectorContent
              key={trace?.traceId}
              trace={trace}
              data={spans}
              error={spansError}
              pending={pending}
            />
          ) : (
            <RuntimeTelemetryContent
              key={trace?.traceId}
              data={telemetry}
              error={telemetryError}
              pending={pending}
            />
          )}
        </div>
      </div>
    </SheetContent>
  )
}

function TraceInspectorTabs({
  value,
  onValueChange,
}: {
  value: TraceInspectorTab
  onValueChange: (value: TraceInspectorTab) => void
}) {
  return (
    <div className="flex items-center gap-4  bg-muted/50 py-2 px-2 [&_svg]:size-4">
      <TraceInspectorTabButton
        icon={Route}
        active={value === "spans"}
        label="Spans"
        onClick={() => onValueChange("spans")}
      />
      <TraceInspectorTabButton
        icon={Server}
        active={value === "telemetry"}
        label="Runtime Telemetry"
        onClick={() => onValueChange("telemetry")}
      />
    </div>
  )
}

function TraceInspectorTabButton({
  icon: Icon,
  active,
  label,
  onClick,
}: {
  icon: LucideIcon
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex h-9 items-center gap-2 px-2 text-sm font-medium text-muted-foreground",
        active && "text-primary"
      )}
      onClick={onClick}
    >
      <Icon />
      {label}
      {active ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" /> : null}
    </button>
  )
}

function SpansInspectorContent({
  trace,
  data,
  error,
  pending,
}: {
  trace?: TraceListItem
  data?: ListSpansActionData
  error?: Error
  pending: boolean
}) {
  const [selectedSpanID, setSelectedSpanID] = React.useState<string | undefined>()
  const [detail, setDetail] = React.useState<SpanDetailActionData | undefined>()
  const [detailError, setDetailError] = React.useState<Error | undefined>()
  const [detailPending, startDetailTransition] = React.useTransition()
  const selectedSpan = selectedSpanID
    ? data?.spans.find((span) => span.spanId === selectedSpanID)
    : data?.spans[0]

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
      setDetail(result.data)
      setDetailError(result.error)
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
                    setDetail(undefined)
                    setDetailError(undefined)
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
        "relative flex w-full flex-col border-l-4 border-transparent py-1.5 pr-4 text-left hover:bg-emerald-500/7 lg:pr-5",
        selected && "border-emerald-500 bg-emerald-500/8"
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
        {span.totalTokens > 0 ? <span>{formatNumber(span.totalTokens)} tokens</span> : null}
        <span className="font-mono">{shortTraceID(span.spanId)}</span>
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
  const title = span?.displayName ?? (trace ? shortTraceID(trace.traceId) : "Trace")

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
          {span ? <span>{formatNumber(span.totalTokens)} tokens</span> : null}
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
        <span className="font-medium text-foreground">{formatNumber(span.totalTokens)} total</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="bg-emerald-500" style={{ width: `${inputWidth}%` }} />
        <span className="bg-yellow-500" style={{ width: `${cachedWidth}%` }} />
        <span className="bg-indigo-500" style={{ width: `${outputWidth}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3 sm:gap-3">
        <TokenLegend colorClass="bg-emerald-500" label="Input" value={span.inputTokens} />
        <TokenLegend colorClass="bg-yellow-500" label="Cached" value={span.cachedInputTokens} />
        <TokenLegend colorClass="bg-indigo-500" label="Output" value={span.outputTokens} />
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
        {label} {formatNumber(value)}
      </span>
    </span>
  )
}

function RuntimeTelemetryContent({
  data,
  error,
  pending,
}: {
  data?: RuntimeTelemetryActionData
  error?: Error
  pending: boolean
}) {
  const [tab, setTab] = React.useState<TelemetryTab>("process")

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

  const processEvents = data.events.filter((event) => event.kind === "process")
  const fileEvents = data.events.filter((event) => event.kind === "file")
  const networkEvents = data.events.filter((event) => event.kind === "network")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-4 overflow-x-auto py-2 px-2">
        <TraceInspectorTabButton
          icon={Cpu}
          active={tab === "process"}
          label={`Process (${data.processCount})`}
          onClick={() => setTab("process")}
        />
        <TraceInspectorTabButton
          icon={HardDrive}
          active={tab === "file"}
          label={`File (${data.fileCount})`}
          onClick={() => setTab("file")}
        />
        <TraceInspectorTabButton
          icon={Network}
          active={tab === "network"}
          label={`Network (${data.networkCount})`}
          onClick={() => setTab("network")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
        {tab === "process" ? <ProcessTelemetryTable key="process" events={processEvents} /> : null}
        {tab === "file" ? <FileTelemetryTable key="file" events={fileEvents} /> : null}
        {tab === "network" ? <NetworkTelemetryTable key="network" events={networkEvents} /> : null}
      </div>
    </div>
  )
}

function spanColorClass(span: SpanListItem) {
  if (span.spanType === "model") {
    return "text-blue-500"
  }

  if (span.spanType === "tool") {
    return "text-fuchsia-500"
  }

  if (span.spanType === "agent") {
    return "text-primary"
  }

  return "text-emerald-500"
}

function spanTimelineClass(span: SpanListItem) {
  if (span.spanType === "model") {
    return "bg-blue-500"
  }

  if (span.spanType === "tool") {
    return "bg-fuchsia-500"
  }

  if (span.spanType === "agent") {
    return "bg-primary"
  }

  return "bg-emerald-500"
}

function ProcessTelemetryTable({ events }: { events: RuntimeTelemetryEventItem[] }) {
  return (
    <TelemetryTable
      emptyText="No process events were recorded in this trace window."
      columns={[
        { header: "Process", headerClassName: "min-w-36", cellClassName: telemetryMonoClass },
        {
          header: "Command / Parent",
          headerClassName: "min-w-80",
          cellClassName: telemetryWideMonoClass,
        },
        { header: "Action" },
        { header: "Last Seen", headerClassName: "min-w-40" },
      ]}
      rows={events.map((event) => [
        event.primary,
        event.secondary,
        <TelemetryActionBadge key={`${event.id}-action`} action={event.action} />,
        <TelemetryTimestamp key={`${event.id}-time`} value={event.time} />,
      ])}
    />
  )
}

function FileTelemetryTable({ events }: { events: RuntimeTelemetryEventItem[] }) {
  return (
    <TelemetryTable
      emptyText="No file events were recorded in this trace window."
      columns={[
        {
          header: "File Path Accessed",
          headerClassName: "min-w-80",
          cellClassName: telemetryWideMonoClass,
        },
        {
          header: "Command / Process",
          headerClassName: "min-w-72",
          cellClassName: telemetryWideMonoClass,
        },
        { header: "Action" },
        { header: "Last Seen", headerClassName: "min-w-40" },
      ]}
      rows={events.map((event) => [
        event.primary,
        event.secondary,
        event.secondary,
        <TelemetryActionBadge key={`${event.id}-action`} action={event.action} />,
        <TelemetryTimestamp key={`${event.id}-time`} value={event.time} />,
      ])}
    />
  )
}

function NetworkTelemetryTable({ events }: { events: RuntimeTelemetryEventItem[] }) {
  return (
    <TelemetryTable
      emptyText="No network events were recorded in this trace window."
      columns={[
        {
          header: "Destination Domain",
          headerClassName: "min-w-52",
          cellClassName: telemetryMonoClass,
        },
        {
          header: "Destination IP",
          headerClassName: "min-w-40",
          cellClassName: telemetryMonoClass,
        },
        {
          header: "Destination Port",
          headerClassName: "min-w-32",
          cellClassName: "font-mono",
        },
        { header: "Protocol", headerClassName: "min-w-32", cellClassName: telemetryMonoClass },
        { header: "Action" },
        { header: "Last Seen", headerClassName: "min-w-40" },
      ]}
      rows={events.map((event) => [
        networkDestinationDomain(event),
        networkDestinationIP(event),
        networkDestinationPort(event),
        networkProtocol(event),
        <TelemetryActionBadge key={`${event.id}-action`} action={event.action} />,
        <TelemetryTimestamp key={`${event.id}-time`} value={event.time} />,
      ])}
    />
  )
}

function TelemetryTable({
  emptyText,
  columns,
  rows,
}: {
  emptyText: string
  columns: {
    header: string
    headerClassName?: string
    cellClassName?: string
  }[]
  rows: React.ReactNode[][]
}) {
  const [page, setPage] = React.useState(0)
  const pageCount = Math.ceil(rows.length / telemetryPageSize)
  const start = page * telemetryPageSize
  const end = start + telemetryPageSize
  const pageRows = rows.slice(start, end)
  const canGoPrevious = page > 0
  const canGoNext = page + 1 < pageCount
  const hasRows = rows.length > 0

  return (
    <section className="flex w-full flex-col">
      <div className="min-h-0 w-full flex-1 overflow-auto border-b">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.header} className={cn("h-8 px-2", column.headerClassName)}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {hasRows ? (
              pageRows.map((row, index) => (
                <TableRow key={index}>
                  {row.map((cell, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      className={cn("h-10 px-2 py-1", columns[cellIndex]?.cellClassName)}
                    >
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-36 w-full text-center text-muted-foreground"
                >
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex w-full flex-col gap-2 pt-2 md:flex-row md:items-center md:justify-between">
        <span className="text-xs text-muted-foreground">
          {hasRows ? `${start + 1}-${Math.min(end, rows.length)} of ${rows.length}` : "0-0 of 0"}
        </span>
        <Pagination className="mx-0 w-full justify-end md:w-auto">
          <PaginationContent>
            <PaginationItem>
              <Button
                type="button"
                variant="ghost"
                disabled={!canGoPrevious}
                onClick={() => setPage((current) => Math.max(current - 1, 0))}
              >
                <ArrowLeft data-icon="inline-start" />
                Previous
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                type="button"
                variant="ghost"
                disabled={!canGoNext}
                onClick={() => setPage((current) => (canGoNext ? current + 1 : current))}
              >
                Next
                <ArrowRight data-icon="inline-end" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </section>
  )
}

function TelemetryActionBadge({ action }: { action: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit rounded-full px-2 py-1 text-xs font-medium",
        action === "Blocked" && "bg-destructive/12 text-destructive",
        action === "Allowed" && "bg-primary/12 text-primary",
        action !== "Allowed" && action !== "Blocked" && "bg-muted text-muted-foreground"
      )}
    >
      {action}
    </span>
  )
}

function TelemetryTimestamp({ value }: { value: string }) {
  return <span className="text-sm">{value}</span>
}

const telemetryMonoClass = "max-w-[16rem] whitespace-normal break-all font-mono text-xs"
const telemetryWideMonoClass = "max-w-[28rem] whitespace-normal break-all font-mono text-xs"

function networkDestinationDomain(event: RuntimeTelemetryEventItem) {
  return event.primary.includes(".") ? event.primary : ""
}

function networkDestinationIP(event: RuntimeTelemetryEventItem) {
  const match = event.secondary.match(/(?:^|\s)(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/)

  return match?.[1] ?? (event.primary.includes(".") ? "" : event.primary)
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
      {formatNumber(value)} {metricLabel(value, singular)}
    </Badge>
  )
}

function metricLabel(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`
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

function shortTraceID(value: string) {
  return shortLensID(value)
}

function formatNumber(value: number) {
  return formatCompactNumber(value)
}
