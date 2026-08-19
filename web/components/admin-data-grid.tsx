"use client"

import type { Route } from "next"
import { flexRender, type Row, type Table as TanStackTable } from "@tanstack/react-table"
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { RoutedTableRow } from "@/components/routed-table-row"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type AdminColumnLayout = {
  width?: number
  minWidth: number
  contentMaxWidth?: number
  align?: "start" | "center" | "end"
  hiddenBelow?: "sm" | "md" | "lg" | "xl"
  pin?: "start" | "end"
}

export type AdminDataGridProps<T> = {
  ariaLabel: string
  rows: T[]
  table: TanStackTable<T>
  layout: Record<string, AdminColumnLayout>
  emptyState: ReactNode
  onRowActivate?: (row: T) => void
  pagination?: ReactNode
  renderSubRow?: (row: T) => ReactNode
  rowAriaLabel?: (row: T) => string
  rowCanActivate?: (row: T) => boolean
  rowHref?: (row: T) => Route | undefined
}

const hiddenClasses = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
} as const

const alignClasses = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
} as const

export function AdminDataGrid<T>({
  ariaLabel,
  emptyState,
  layout,
  onRowActivate,
  pagination,
  renderSubRow,
  rowAriaLabel,
  rowCanActivate,
  rowHref,
  rows,
  table,
}: AdminDataGridProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const element = tableRef.current
    if (!viewport || !element) return

    const measure = () => setOverflowing(element.scrollWidth > viewport.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [rows])

  if (rows.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {emptyState}
        {pagination}
      </div>
    )
  }

  const columns = table.getVisibleLeafColumns()
  const declaredLayout = (columnId: string) => {
    const columnLayout = layout[columnId]
    if (!columnLayout) throw new Error(`AdminDataGrid column "${columnId}" has no layout`)
    return columnLayout
  }
  const startOffsets = new Map<string, number>()
  const endOffsets = new Map<string, number>()
  let start = 0
  for (const column of columns) {
    const columnLayout = declaredLayout(column.id)
    if (columnLayout.pin !== "start") continue
    startOffsets.set(column.id, start)
    start += columnLayout.width ?? columnLayout.minWidth
  }
  let end = 0
  for (const column of columns.toReversed()) {
    const columnLayout = declaredLayout(column.id)
    if (columnLayout.pin !== "end") continue
    endOffsets.set(column.id, end)
    end += columnLayout.width ?? columnLayout.minWidth
  }
  const lastStart = columns.findLast((column) => declaredLayout(column.id).pin === "start")?.id
  const firstEnd = columns.find((column) => declaredLayout(column.id).pin === "end")?.id

  const cell = (row: Row<T>) =>
    row.getVisibleCells().map((item) => {
      const columnLayout = declaredLayout(item.column.id)
      const pinned = overflowing && columnLayout.pin
      const outerPinnedEdge =
        (columnLayout.pin === "start" && item.column.id === lastStart) ||
        (columnLayout.pin === "end" && item.column.id === firstEnd)

      return (
        <TableCell
          className={cn(
            alignClasses[columnLayout.align ?? "start"],
            columnLayout.hiddenBelow && hiddenClasses[columnLayout.hiddenBelow],
            pinned &&
              "bg-background group-hover:bg-muted/30 group-data-[state=selected]:bg-muted z-10",
            pinned &&
              outerPinnedEdge &&
              columnLayout.pin === "start" &&
              "border-r shadow-[4px_0_8px_-6px_rgb(0_0_0/0.4)]",
            pinned &&
              outerPinnedEdge &&
              columnLayout.pin === "end" &&
              "border-l shadow-[-4px_0_8px_-6px_rgb(0_0_0/0.4)]"
          )}
          key={item.id}
          style={{
            left: pinned === "start" ? startOffsets.get(item.column.id) : undefined,
            minWidth: columnLayout.minWidth,
            position: pinned ? "sticky" : undefined,
            right: pinned === "end" ? endOffsets.get(item.column.id) : undefined,
            width: columnLayout.width,
          }}
        >
          <div className="min-w-0" style={{ maxWidth: columnLayout.contentMaxWidth }}>
            {flexRender(item.column.columnDef.cell, item.getContext())}
          </div>
        </TableCell>
      )
    })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        aria-label={overflowing ? ariaLabel : undefined}
        className={cn(
          "w-full min-w-0 overscroll-x-contain border-b",
          overflowing ? "overflow-x-auto" : "overflow-x-clip"
        )}
        ref={viewportRef}
        role={overflowing ? "region" : undefined}
        tabIndex={overflowing ? 0 : undefined}
      >
        <table
          aria-label={ariaLabel}
          className="w-max min-w-full table-auto caption-bottom text-sm"
          ref={tableRef}
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const columnLayout = declaredLayout(header.column.id)
                  const pinned = overflowing && columnLayout.pin
                  const outerPinnedEdge =
                    (columnLayout.pin === "start" && header.column.id === lastStart) ||
                    (columnLayout.pin === "end" && header.column.id === firstEnd)
                  const title =
                    typeof header.column.columnDef.header === "string"
                      ? header.column.columnDef.header
                      : undefined

                  return (
                    <TableHead
                      className={cn(
                        alignClasses[columnLayout.align ?? "start"],
                        columnLayout.hiddenBelow && hiddenClasses[columnLayout.hiddenBelow],
                        pinned && "bg-muted z-20",
                        pinned && outerPinnedEdge && columnLayout.pin === "start" && "border-r",
                        pinned && outerPinnedEdge && columnLayout.pin === "end" && "border-l"
                      )}
                      key={header.id}
                      style={{
                        left: pinned === "start" ? startOffsets.get(header.column.id) : undefined,
                        minWidth: columnLayout.minWidth,
                        position: pinned ? "sticky" : undefined,
                        right: pinned === "end" ? endOffsets.get(header.column.id) : undefined,
                        width: columnLayout.width,
                      }}
                    >
                      <div
                        className="max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                        title={title}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const href = rowHref?.(row.original)
              const canActivate = onRowActivate && (rowCanActivate?.(row.original) ?? true)
              const ariaLabel = rowAriaLabel?.(row.original) ?? `Open row ${row.id}`
              const renderedRow = href ? (
                <RoutedTableRow
                  aria-label={ariaLabel}
                  className="group"
                  data-state={row.getIsSelected() && "selected"}
                  href={href}
                  key={row.id}
                >
                  {cell(row)}
                </RoutedTableRow>
              ) : canActivate ? (
                <TableRow
                  aria-label={ariaLabel}
                  className="group cursor-pointer focus-visible:ring-2 focus-visible:ring-inset"
                  data-state={row.getIsSelected() && "selected"}
                  key={row.id}
                  onClick={() => onRowActivate(row.original)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    onRowActivate(row.original)
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {cell(row)}
                </TableRow>
              ) : (
                <TableRow
                  className="group"
                  data-state={row.getIsSelected() && "selected"}
                  key={row.id}
                >
                  {cell(row)}
                </TableRow>
              )
              const subRow = renderSubRow?.(row.original)

              return (
                <Fragment key={row.id}>
                  {renderedRow}
                  {subRow ? (
                    <TableRow>
                      <TableCell
                        className="bg-muted/20 px-4 py-4 whitespace-normal"
                        colSpan={row.getVisibleCells().length}
                      >
                        {subRow}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              )
            })}
          </TableBody>
        </table>
      </div>
      {pagination}
    </div>
  )
}
