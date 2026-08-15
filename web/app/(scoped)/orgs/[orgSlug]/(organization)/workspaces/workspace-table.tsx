"use client"

import type { Route } from "next"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { RoutedTableRow } from "@/components/routed-table-row"
import { StatusBadge } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Workspace } from "@/lib/gateway/client"
import { TableRelativeTime } from "@/components/ui/table"
import { WorkspaceTableActions } from "./workspace-table-actions"

export function WorkspaceTable({
  hasNextPage,
  nextPageToken,
  orgSlug,
  workspaces,
}: {
  hasNextPage: boolean
  nextPageToken: string
  orgSlug: string
  workspaces: Workspace[]
}) {
  "use no memo"

  const root = `/orgs/${orgSlug}`
  const columns = useMemo<ColumnDef<Workspace>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "state",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.state} />,
      },
      {
        accessorKey: "workspace_admin_count",
        header: "Administrators",
        cell: ({ row }) => row.original.workspace_admin_count,
      },
      {
        accessorKey: "updated_at",
        header: "Updated",
        cell: ({ row }) => <TableRelativeTime value={row.original.updated_at} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <WorkspaceTableActions
            name={row.original.name}
            orgSlug={orgSlug}
            workspaceId={row.original.id}
            workspaceSlug={row.original.slug}
          />
        ),
      },
    ],
    [orgSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ columns, data: workspaces, getCoreRowModel: getCoreRowModel() })

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full min-w-0 border-b">
        <Table aria-label="Workspaces" className="w-full table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    className={
                      header.column.id === "state"
                        ? "w-36"
                        : header.column.id === "workspace_admin_count"
                          ? "w-36 text-right"
                          : header.column.id === "updated_at"
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
                  aria-label={`Manage ${row.original.name}`}
                  href={`${root}/workspaces/manage/${row.original.slug}` as Route}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      className={
                        cell.column.id === "workspace_admin_count"
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
      <TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />
    </div>
  )
}
