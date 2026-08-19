"use client"

import type { Route } from "next"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { UserIdentity } from "@/components/ui/avatar"
import { TokenTablePagination } from "@/components/table-pagination"
import { EmptyValue, RelativeDateTime } from "@/components/ui/table"
import type { ActiveMember, InvitationRow, MemberDirectory, MemberTab } from "@/data/members"
import { DisabledUserActions, InvitationActions, UserTableActions } from "./member-actions"

const memberLayout = {
  user: { minWidth: 256 },
  assignments: { minWidth: 176, width: 176 },
  ownedAgents: { align: "end", minWidth: 112, width: 112 },
  sharedAgents: { align: "end", minWidth: 96, width: 96 },
  apiKeys: { align: "end", minWidth: 96, width: 96 },
  lastActivity: { minWidth: 128, width: 128 },
  createdAt: { minWidth: 128, width: 128 },
  actions: { align: "end", minWidth: 64, width: 64 },
} satisfies Record<string, AdminColumnLayout>

const invitationLayout = {
  createdAt: { minWidth: 144, width: 144 },
  assignments: { minWidth: 176 },
  inviter: { contentMaxWidth: 256, minWidth: 224 },
  expiresAt: { minWidth: 128, width: 128 },
  actions: { align: "end", minWidth: 80, width: 80 },
} satisfies Record<string, AdminColumnLayout>

export function UserDirectoryTable({
  data,
  orgSlug,
  tab,
}: {
  data: MemberDirectory
  orgSlug: string
  tab: MemberTab
}) {
  return tab === "invited" ? (
    <InvitationTable data={data} orgSlug={orgSlug} />
  ) : (
    <MemberTable data={data} disabled={tab === "disabled"} orgSlug={orgSlug} />
  )
}

function MemberTable({
  data,
  disabled,
  orgSlug,
}: {
  data: MemberDirectory
  disabled: boolean
  orgSlug: string
}) {
  "use no memo"

  const members = disabled ? data.disabled : data.active
  const columns = useMemo<ColumnDef<ActiveMember>[]>(
    () => [
      {
        id: "user",
        header: "User",
        cell: ({ row }) => (
          <UserIdentity
            email={row.original.email}
            image={row.original.image}
            name={row.original.name}
            size="default"
          />
        ),
      },
      {
        id: "assignments",
        header: "Assignments",
        cell: ({ row }) => (
          <AssignmentSummary roles={row.original.roles} teams={row.original.teams} />
        ),
      },
      { accessorKey: "ownedAgents", header: "Agents" },
      { accessorKey: "sharedAgents", header: "Shared" },
      { accessorKey: "apiKeys", header: "API keys" },
      {
        accessorKey: "lastActivity",
        header: "Last active",
        cell: ({ row }) =>
          row.original.lastActivity ? (
            <RelativeDateTime value={row.original.lastActivity} />
          ) : (
            <EmptyValue />
          ),
      },
      {
        accessorKey: "createdAt",
        header: "Joined",
        cell: ({ row }) => <RelativeDateTime value={row.original.createdAt} />,
      },
      ...(disabled
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">Actions</span>,
              cell: ({ row }) => (
                <DisabledUserActions
                  memberId={row.original.id}
                  name={row.original.name}
                  orgSlug={orgSlug}
                />
              ),
            } satisfies ColumnDef<ActiveMember>,
          ]
        : [
            {
              id: "actions",
              header: () => <span className="sr-only">Actions</span>,
              cell: ({ row }) => (
                <UserTableActions
                  memberId={row.original.id}
                  name={row.original.name}
                  orgSlug={orgSlug}
                />
              ),
            } satisfies ColumnDef<ActiveMember>,
          ]),
    ],
    [disabled, orgSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: members,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })
  return (
    <DirectoryTable
      ariaLabel={disabled ? "Disabled Users" : "Active Users"}
      layout={memberLayout}
      nextPageToken={data.nextPageToken}
      rows={members}
      table={table}
      rowHref={(row) => `/orgs/${orgSlug}/users/${row.id}` as Route}
    />
  )
}

function InvitationTable({ data, orgSlug }: { data: MemberDirectory; orgSlug: string }) {
  "use no memo"

  const columns = useMemo<ColumnDef<InvitationRow>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => <RelativeDateTime value={row.original.createdAt} />,
      },
      {
        id: "assignments",
        header: "Initial access",
        cell: ({ row }) => (
          <AssignmentSummary roles={row.original.roles} teams={row.original.teams} />
        ),
      },
      {
        id: "inviter",
        header: "Inviter",
        cell: ({ row }) => (
          <UserIdentity
            email={row.original.inviterEmail}
            image={row.original.inviterImage}
            name={row.original.inviterName}
          />
        ),
      },
      {
        accessorKey: "expiresAt",
        header: "Expiry",
        cell: ({ row }) => (
          <>
            <RelativeDateTime value={row.original.expiresAt} />
            {row.original.expired ? <Badge variant="destructivePlain">Expired</Badge> : null}
          </>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => <InvitationActions invitationId={row.original.id} orgSlug={orgSlug} />,
      },
    ],
    [orgSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: data.invited,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })
  return (
    <DirectoryTable
      ariaLabel="Pending Invitations"
      layout={invitationLayout}
      nextPageToken={data.nextPageToken}
      rows={data.invited}
      table={table}
    />
  )
}

function DirectoryTable<T>({
  ariaLabel,
  layout,
  nextPageToken,
  rowHref,
  rows,
  table,
}: {
  ariaLabel: string
  layout: Record<string, AdminColumnLayout>
  nextPageToken: string
  rowHref?: (row: T) => Route
  rows: T[]
  table: ReturnType<typeof useReactTable<T>>
}) {
  return (
    <AdminDataGrid
      ariaLabel={ariaLabel}
      emptyState={
        <AdministrationState
          description="Invite people and choose the Roles and Teams they receive when they join."
          kind="welcome"
          title="Let's invite your team"
        />
      }
      layout={layout}
      pagination={
        <TokenTablePagination hasNextPage={Boolean(nextPageToken)} nextPageToken={nextPageToken} />
      }
      rowHref={rowHref}
      rows={rows}
      table={table}
    />
  )
}

function AssignmentSummary({ roles, teams }: { roles: string[]; teams: string[] }) {
  return (
    <span className="text-sm whitespace-nowrap tabular-nums">
      Roles: {roles.length} <span className="text-muted-foreground">·</span> Teams: {teams.length}
    </span>
  )
}
