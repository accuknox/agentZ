"use client"

import type { Route } from "next"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { ScopeBadge } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import type { OrganizationRoleSummary } from "@/data/roles"
import { RelativeDateTime } from "@/components/ui/table"
import { RoleTableActions } from "./role-table-actions"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  scope: { minWidth: 96, width: 96 },
  immutable: { minWidth: 80, width: 80 },
  users: { minWidth: 64, width: 64, align: "end" },
  teams: { minWidth: 64, width: 64, align: "end" },
  permissions: { minWidth: 112, width: 112, align: "end" },
  dependencyState: { minWidth: 128, width: 128 },
  updatedAt: { minWidth: 144, width: 144 },
  actions: { minWidth: 64, width: 64 },
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
        cell: ({ row }) => <RelativeDateTime value={row.original.updatedAt} />,
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
  const table = useReactTable({
    columns,
    data: roles,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  return (
    <AdminDataGrid
      ariaLabel={workspaceSlug ? "Workspace roles" : "Organization roles"}
      emptyState={<p className="text-muted-foreground py-8 text-center">No roles found.</p>}
      layout={layout}
      pagination={
        <TokenTablePagination hasNextPage={nextPageToken !== ""} nextPageToken={nextPageToken} />
      }
      rowHref={(role) => `${root}/${role.id}/permissions` as Route}
      rows={roles}
      table={table}
    />
  )
}
