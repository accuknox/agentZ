"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  type ColumnDef,
  useReactTable,
} from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { TablePagination } from "@/components/table-pagination"
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
  "use no memo"

  const isServerPaginated = hasNextPage !== undefined
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
    getPaginationRowModel: isServerPaginated ? undefined : getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize } },
    manualPagination: isServerPaginated,
  })

  return (
    <section className="flex w-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto border-b">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id} className={columns[header.index]?.className}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={columns[cell.column.getIndex()]?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
      <div className="bg-muted/10 py-3">
        <TablePagination
          canGoNext={isServerPaginated ? Boolean(hasNextPage) : table.getCanNextPage()}
          canGoPrevious={isServerPaginated ? Boolean(canGoPrevious) : table.getCanPreviousPage()}
          goNext={() => {
            if (isServerPaginated) {
              if (nextPageToken) onNextPage?.(nextPageToken)
              return
            }
            table.nextPage()
          }}
          goPrevious={() => {
            if (isServerPaginated) {
              onPreviousPage?.()
              return
            }
            table.previousPage()
          }}
          pending={pending}
        />
      </div>
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
