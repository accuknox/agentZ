"use client"

import type { Route } from "next"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { StatusBadge } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import type { Workspace } from "@/lib/gateway/client"
import { RelativeDateTime } from "@/components/ui/table"
import { WorkspaceTableActions } from "./workspace-table-actions"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  state: { minWidth: 144, width: 144 },
  workspace_admin_count: { minWidth: 144, width: 144, align: "end" },
  updated_at: { minWidth: 128, width: 128 },
  actions: { minWidth: 64, width: 64 },
}

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
        cell: ({ row }) => <RelativeDateTime value={row.original.updated_at} />,
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
  const table = useReactTable({
    columns,
    data: workspaces,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  return (
    <AdminDataGrid
      ariaLabel="Workspaces"
      emptyState={<p className="text-muted-foreground py-8 text-center">No workspaces found.</p>}
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(workspace) => `${root}/workspaces/manage/${workspace.slug}` as Route}
      rows={workspaces}
      table={table}
    />
  )
}
