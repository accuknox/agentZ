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
import { TableRelativeTime } from "@/components/ui/table"
import { RoleTableActions } from "./role-table-actions"

const headerClassName: Readonly<Record<string, string | undefined>> = {
  actions: "w-16",
  dependencyState: "w-32",
  immutable: "w-20",
  permissions: "w-28 text-right",
  scope: "w-24",
  teams: "w-16 text-right",
  updatedAt: "w-36",
  users: "w-16 text-right",
}

const cellClassName: Readonly<Record<string, string | undefined>> = {
  name: "min-w-0",
  permissions: "text-right tabular-nums",
  teams: "text-right tabular-nums",
  users: "text-right tabular-nums",
}

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
        cell: ({ row }) => (
          <span className="block truncate font-medium" title={row.original.name}>
            {row.original.name}
          </span>
        ),
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
        cell: ({ row }) => <TableRelativeTime value={row.original.updatedAt} />,
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
          className="w-full min-w-3xl table-fixed"
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead className={headerClassName[header.column.id]} key={header.id}>
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
                    <TableCell className={cellClassName[cell.column.id]} key={cell.id}>
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
      <TokenTablePagination hasNextPage={nextPageToken !== ""} nextPageToken={nextPageToken} />
    </div>
  )
}
