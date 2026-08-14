"use client"

import type { Route } from "next"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { RoutedTableRow } from "@/components/routed-table-row"
import { ScopeBadge } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { OrganizationRoleSummary } from "@/data/roles"
import { formatAge } from "@/lib/format"
import { RoleTableActions } from "./role-table-actions"

export function RoleTable({
  nextPageToken,
  orgSlug,
  roles,
  workspaceSlug,
}: {
  nextPageToken: string
  orgSlug: string
  roles: OrganizationRoleSummary[]
  workspaceSlug?: string
}) {
  "use no memo"

  const root = workspaceSlug
    ? `/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles`
    : `/orgs/${orgSlug}/roles`
  const columns = useMemo<ColumnDef<OrganizationRoleSummary>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      ...(workspaceSlug
        ? [
            {
              id: "scope",
              header: "Scope",
              cell: () => <ScopeBadge scope="Workspace" />,
            } satisfies ColumnDef<OrganizationRoleSummary>,
          ]
        : []),
      {
        accessorKey: "immutable",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant="plain">{row.original.immutable ? "System" : "Custom"}</Badge>
        ),
      },
      { accessorKey: "users", header: "Users" },
      { accessorKey: "teams", header: "Teams" },
      {
        id: "permissions",
        header: "Permissions",
        cell: ({ row }) =>
          row.original.systemRole === "superadmin" || row.original.systemRole === "workspace_admin"
            ? "All"
            : row.original.permissionCount,
      },
      {
        accessorKey: "dependencyState",
        header: "Dependencies",
        cell: ({ row }) => (
          <Badge
            variant={row.original.dependencyState === "Needs repair" ? "warningPlain" : "plain"}
          >
            {row.original.dependencyState}
          </Badge>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => (
          <time dateTime={row.original.updatedAt}>{formatAge(row.original.updatedAt)}</time>
        ),
      },
      ...(!workspaceSlug
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">Actions</span>,
              cell: ({ row }) => (
                <RoleTableActions
                  immutable={row.original.immutable}
                  name={row.original.name}
                  orgSlug={orgSlug}
                  roleId={row.original.id}
                />
              ),
            } satisfies ColumnDef<OrganizationRoleSummary>,
          ]
        : []),
    ],
    [orgSlug, workspaceSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ columns, data: roles, getCoreRowModel: getCoreRowModel() })

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full min-w-0 border-b">
        <Table
          aria-label={workspaceSlug ? "Workspace Roles" : "Organisation Roles"}
          className="w-full min-w-4xl table-fixed"
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    className={
                      header.column.id === "name"
                        ? "w-64"
                        : header.column.id === "scope" || header.column.id === "immutable"
                          ? "w-28"
                          : header.column.id === "users" || header.column.id === "teams"
                            ? "w-20 text-right"
                            : header.column.id === "permissions"
                              ? "w-28 text-right"
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
                  href={`${root}/${row.original.id}/permissions` as Route}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      className={
                        ["users", "teams", "permissions"].includes(cell.column.id)
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
                  No roles
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
