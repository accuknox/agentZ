"use client"

import type { Route } from "next"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TokenTablePagination } from "@/components/table-pagination"
import type { TeamSummary } from "@/data/teams"
import { RelativeDateTime } from "@/components/ui/table"
import { TeamTableActions } from "./team-table-actions"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320, pin: "start" },
  memberCount: { minWidth: 112, width: 112, align: "end" },
  roleCount: { minWidth: 96, width: 96, align: "end" },
  accessibleWorkspaceCount: { minWidth: 128, width: 128, align: "end" },
  updatedAt: { minWidth: 128, width: 128 },
  actions: { minWidth: 64, width: 64, pin: "end" },
}

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
        cell: ({ row }) => <RelativeDateTime value={row.original.updatedAt} />,
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
    <AdminDataGrid
      ariaLabel="Teams"
      emptyState={<p className="text-muted-foreground py-8 text-center">No teams found.</p>}
      layout={layout}
      pagination={
        <TokenTablePagination hasNextPage={Boolean(nextPageToken)} nextPageToken={nextPageToken} />
      }
      rowHref={(team) => `${root}/${team.id}` as Route}
      rows={teams}
      table={table}
    />
  )
}
