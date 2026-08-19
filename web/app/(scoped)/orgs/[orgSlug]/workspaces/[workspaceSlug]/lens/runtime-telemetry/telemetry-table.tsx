"use client"

import * as React from "react"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Badge } from "@/components/ui/badge"
import { TablePagination } from "@/components/table-pagination"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type TelemetryTableColumn<T> = {
  header: string
  layout: AdminColumnLayout
  render: (row: T) => React.ReactNode
  key: string
}

interface TelemetryTableProps<T> {
  data: T[]
  columns: TelemetryTableColumn<T>[]
  emptyText: string
  hasNextPage: boolean
  nextPageToken: string
  canGoPrevious: boolean
  onNextPage: (nextPageToken: string) => void
  onPreviousPage: () => void
  pending?: boolean
}

export function TelemetryTable<T extends { [key: string]: unknown }>({
  data,
  columns,
  emptyText,
  hasNextPage,
  nextPageToken,
  canGoPrevious,
  onNextPage,
  onPreviousPage,
  pending,
}: TelemetryTableProps<T>) {
  "use no memo"

  const tableColumns = React.useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        header: column.header,
        cell: ({ row }) => column.render(row.original),
      })),
    [columns]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  })
  const layout = columns.reduce<Record<string, AdminColumnLayout>>((result, column) => {
    result[column.key] = column.layout
    return result
  }, {})

  return (
    <section className="flex w-full flex-1 flex-col">
      <AdminDataGrid
        ariaLabel="Runtime telemetry"
        emptyState={<p className="text-muted-foreground py-8 text-center">{emptyText}</p>}
        layout={layout}
        pagination={
          <div className="bg-muted/10 py-3">
            <TablePagination
              canGoNext={hasNextPage}
              canGoPrevious={canGoPrevious}
              goNext={() => {
                if (nextPageToken) onNextPage(nextPageToken)
              }}
              goPrevious={onPreviousPage}
              pending={pending}
            />
          </div>
        }
        rows={data}
        table={table}
      />
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
    return <span className={cn("text-muted-foreground font-mono text-xs", className)}>_</span>
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
