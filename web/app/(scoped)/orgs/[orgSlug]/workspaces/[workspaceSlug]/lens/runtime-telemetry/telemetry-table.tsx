"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type TelemetryTableColumn<T> = {
  header: string
  className?: string
  render: (row: T) => React.ReactNode
  key: string
}

interface TelemetryTableProps<T> {
  data: T[]
  columns: TelemetryTableColumn<T>[]
  emptyText: string
  pageSize?: number
  hasNextPage?: boolean
  nextPageToken?: string
  canGoPrevious?: boolean
  onNextPage?: (nextPageToken: string) => void
  onPreviousPage?: () => void
  pending?: boolean
}

const defaultPageSize = 15

export function TelemetryTable<T extends { [key: string]: unknown }>({
  data,
  columns,
  emptyText,
  pageSize = defaultPageSize,
  hasNextPage,
  nextPageToken,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  pending,
}: TelemetryTableProps<T>) {
  const isServerPaginated = hasNextPage !== undefined
  const [page, setPage] = React.useState(0)
  const totalPages = Math.ceil(data.length / pageSize)
  const start = page * pageSize
  const end = start + pageSize
  const pageRows = isServerPaginated ? data : data.slice(start, end)
  const canGoPreviousClient = page > 0
  const canGoNextClient = page + 1 < totalPages
  const hasRows = data.length > 0
  const showPagination = isServerPaginated ? Boolean(canGoPrevious || hasNextPage) : totalPages > 1

  return (
    <section className="flex w-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto border-b">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key} className={col.className}>
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {hasRows ? (
              pageRows.map((row, idx) => (
                <TableRow key={idx}>
                  {columns.map((col) => (
                    <TableCell key={col.key} className={col.className}>
                      {col.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-muted-foreground h-36 w-full text-center"
                >
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {showPagination ? (
        <div className="bg-muted/10 flex w-full flex-col gap-2 px-6 py-3 md:flex-row md:items-center md:justify-between">
          <span className="text-muted-foreground text-xs">
            {isServerPaginated
              ? `${data.length} rows`
              : `${start + 1}-${Math.min(end, data.length)} of ${data.length}`}
          </span>
          <div className="flex gap-2">
            {isServerPaginated ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canGoPrevious || pending}
                  onClick={onPreviousPage}
                >
                  <ArrowLeft data-icon="inline-start" />
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!hasNextPage || pending}
                  onClick={() => nextPageToken && onNextPage?.(nextPageToken)}
                >
                  Next
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canGoPreviousClient}
                  onClick={() => setPage((p) => Math.max(p - 1, 0))}
                >
                  <ArrowLeft data-icon="inline-start" />
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canGoNextClient}
                  onClick={() => setPage((p) => (canGoNextClient ? p + 1 : p))}
                >
                  Next
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge
      variant={action === "Blocked" ? "destructive" : action === "Allowed" ? "success" : "pending"}
    >
      {action}
    </Badge>
  )
}

export function TruncateCell({ value, className }: { value: string; className?: string }) {
  if (!value) {
    return <span className={cn("font-mono text-xs", className)} />
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("block max-w-full min-w-0 truncate font-mono text-xs", className)}>
            {value}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-120 font-mono text-xs break-all">{value}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
