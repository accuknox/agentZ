"use client"

import Link from "next/link"
import * as React from "react"
import { flexRender, getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CircleAlert,
  type LucideIcon,
  Route,
  Wrench,
} from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { Error } from "@/lib/gateway/client"
import type { ListTracesActionData, TraceListItem } from "@/data/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

const numberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

const columnClassName: Record<string, string> = {
  trace: "min-w-32 w-[18%]",
  duration: "min-w-56 w-[22%]",
  graph: "min-w-72 w-[38%]",
  tokens: "min-w-52 w-[22%]",
}

const columns: ColumnDef<TraceListItem>[] = [
  {
    id: "trace",
    header: "Trace",
    cell: ({ row }) => {
      const trace = row.original

      return (
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/lens/traces/${trace.traceId}`}
            className="font-mono text-xs font-medium text-foreground after:absolute after:inset-0 hover:underline"
          >
            {shortTraceID(trace.traceId)}
          </Link>
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
        <div className="flex flex-col gap-2">
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
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
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

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: data?.traces ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

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
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-md">
        <Table className="table-fixed">
          <TableHeader className="[&_tr]:border-0">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted/40 hover:bg-muted/40">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn("h-11 px-4", columnClassName[header.column.id])}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className="[&_tr]:border-0">
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="group relative border-0 odd:bg-background even:bg-muted/25"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn("h-16 px-4", columnClassName[cell.column.id])}
                    >
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
      <div className="flex w-full items-center gap-3 px-1">
        <span className="text-xs text-muted-foreground">{data.traces.length} rows</span>
        <TracePagination hasNextPage={data.hasNextPage} nextPageToken={data.nextPageToken} />
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
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const stack = tokenStack(searchParams.get("token_stack"))
  const currentPageToken = searchParams.get("page_token")
  const canGoPrevious = stack.length > 0 || currentPageToken !== null

  function replace(values: { pageToken?: string; tokenStack?: string[] }) {
    const params = new URLSearchParams(searchParams)
    if (values.pageToken) {
      params.set("page_token", values.pageToken)
    } else {
      params.delete("page_token")
    }

    if (values.tokenStack && values.tokenStack.length > 0) {
      params.set("token_stack", values.tokenStack.join(","))
    } else {
      params.delete("token_stack")
    }

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`)
    })
  }

  return (
    <Pagination className="mx-0 ml-auto w-fit justify-end" data-pending={pending}>
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            disabled={!canGoPrevious || pending}
            onClick={() => {
              const nextStack = stack.slice(0, -1)
              replace({ pageToken: stack.at(-1), tokenStack: nextStack })
            }}
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
            onClick={() => {
              replace({
                pageToken: nextPageToken,
                tokenStack: currentPageToken ? [...stack, currentPageToken] : stack,
              })
            }}
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

function tokenStack(value: string | null) {
  if (!value) {
    return []
  }

  return value.split(",").filter(Boolean)
}

function shortTraceID(value: string) {
  return value.slice(0, 8)
}

function formatNumber(value: number) {
  return numberFormatter.format(value)
}
