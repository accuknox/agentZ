"use client"

import type { Route } from "next"
import { flexRender, type Row, type Table as TanStackTable } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
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
    return <div className="flex min-w-0 flex-col gap-4">{emptyState}</div>
  }

  const declaredLayout = (columnId: string) => {
    const columnLayout = layout[columnId]
    if (!columnLayout) throw new Error(`AdminDataGrid column "${columnId}" has no layout`)
    return columnLayout
  }
  const cell = (row: Row<T>) =>
    row.getVisibleCells().map((item) => {
      const columnLayout = declaredLayout(item.column.id)

      return (
        <TableCell
          className={cn(
            alignClasses[columnLayout.align ?? "start"],
            columnLayout.hiddenBelow && hiddenClasses[columnLayout.hiddenBelow]
          )}
          key={item.id}
          style={{
            minWidth: columnLayout.minWidth,
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
                  const title =
                    typeof header.column.columnDef.header === "string"
                      ? header.column.columnDef.header
                      : undefined
                  const sorted = header.column.getIsSorted()

                  return (
                    <TableHead
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        alignClasses[columnLayout.align ?? "start"],
                        columnLayout.hiddenBelow && hiddenClasses[columnLayout.hiddenBelow]
                      )}
                      key={header.id}
                      style={{
                        minWidth: columnLayout.minWidth,
                        width: columnLayout.width,
                      }}
                    >
                      <div
                        className="max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                        title={title}
                      >
                        {header.isPlaceholder ? null : header.column.columnDef.enableSorting ===
                          true ? (
                          <button
                            className="hover:text-foreground inline-flex h-8 max-w-full items-center gap-1.5"
                            onClick={header.column.getToggleSortingHandler()}
                            type="button"
                          >
                            <span className="truncate">
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </span>
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3.5 shrink-0" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3.5 shrink-0" />
                            ) : (
                              <ArrowUpDown className="size-3.5 shrink-0 opacity-60" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
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
