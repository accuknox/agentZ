"use client"

import type { Route } from "next"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { RoutedTableRow } from "@/components/routed-table-row"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TeamSummary } from "@/data/teams"
import { formatAge } from "@/lib/format"
import { TeamTableActions } from "./team-table-actions"

export function TeamTable({
  nextPageToken,
  orgSlug,
  teams,
}: {
  nextPageToken: string
  orgSlug: string
  teams: TeamSummary[]
}) {
  "use no memo"

  const root = `/orgs/${orgSlug}/teams`
  const columns = useMemo<ColumnDef<TeamSummary>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="block truncate font-medium" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      { accessorKey: "memberCount", header: "Members" },
      { accessorKey: "roleCount", header: "Roles" },
      { accessorKey: "accessibleWorkspaceCount", header: "Workspaces" },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => (
          <time dateTime={row.original.updatedAt}>{formatAge(row.original.updatedAt)}</time>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <TeamTableActions name={row.original.name} orgSlug={orgSlug} teamId={row.original.id} />
        ),
      },
    ],
    [orgSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ columns, data: teams, getCoreRowModel: getCoreRowModel() })

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full min-w-0 border-b">
        <Table aria-label="Teams" className="w-full table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    className={
                      header.column.id === "memberCount"
                        ? "w-28 text-right"
                        : header.column.id === "roleCount"
                          ? "w-24 text-right"
                          : header.column.id === "accessibleWorkspaceCount"
                            ? "w-32 text-right"
                            : header.column.id === "updatedAt"
                              ? "w-32"
                              : header.column.id === "actions"
                                ? "w-14"
                                : undefined
                    }
                    key={header.id}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <RoutedTableRow
                  aria-label={`Open ${row.original.name}`}
                  href={`${root}/${row.original.id}` as Route}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      className={
                        cell.column.id === "name"
                          ? "max-w-72"
                          : ["memberCount", "roleCount", "accessibleWorkspaceCount"].includes(
                                cell.column.id
                              )
                            ? "text-right tabular-nums"
                            : undefined
                      }
                      key={cell.id}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </RoutedTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={columns.length}>
                  <span className="text-muted-foreground">_</span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <TokenTablePagination hasNextPage={Boolean(nextPageToken)} nextPageToken={nextPageToken} />
    </div>
  )
}
