"use client"

import type { Route } from "next"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { UserIdentity } from "@/components/ui/avatar"
import { RoutedTableRow } from "@/components/routed-table-row"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  EmptyValue,
  TableHead,
  TableHeader,
  TableRelativeTime,
  TableRow,
} from "@/components/ui/table"
import type { ActiveMember, InvitationRow, MemberDirectory, MemberTab } from "@/data/members"
import { InvitationActions, MembershipStateButton, UserTableActions } from "./member-actions"

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
            <TableRelativeTime value={row.original.lastActivity} />
          ) : (
            <EmptyValue />
          ),
      },
      {
        accessorKey: "createdAt",
        header: "Joined",
        cell: ({ row }) => <TableRelativeTime value={row.original.createdAt} />,
      },
      ...(disabled
        ? [
            {
              id: "action",
              header: "Action",
              cell: ({ row }) => (
                <MembershipStateButton disabled memberId={row.original.id} orgSlug={orgSlug} />
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
  const table = useReactTable({ columns, data: members, getCoreRowModel: getCoreRowModel() })
  return (
    <DirectoryTable
      ariaLabel={disabled ? "Disabled Users" : "Active Users"}
      cellClassNames={{ user: "max-w-72" }}
      columns={columns}
      nextPageToken={data.nextPageToken}
      headerClassNames={{
        action: "w-28 text-right",
        actions: "w-20",
        apiKeys: "w-24 text-right",
        assignments: "w-44",
        createdAt: "w-32",
        lastActivity: "w-32",
        ownedAgents: "w-28 text-right",
        sharedAgents: "w-24 text-right",
        user: "w-64",
      }}
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
        cell: ({ row }) => <TableRelativeTime value={row.original.createdAt} />,
      },
      {
        id: "assignments",
        header: "Initial Access",
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
            <TableRelativeTime value={row.original.expiresAt} />
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
  const table = useReactTable({ columns, data: data.invited, getCoreRowModel: getCoreRowModel() })
  return (
    <DirectoryTable
      ariaLabel="Pending Invitations"
      cellClassNames={{ inviter: "max-w-56 truncate" }}
      columns={columns}
      nextPageToken={data.nextPageToken}
      headerClassNames={{
        actions: "w-20 text-right",
        createdAt: "w-48",
        expiresAt: "w-32",
        inviter: "w-56",
      }}
      table={table}
    />
  )
}

function DirectoryTable<T>({
  ariaLabel,
  cellClassNames,
  columns,
  headerClassNames,
  nextPageToken,
  rowHref,
  table,
}: {
  ariaLabel: string
  cellClassNames: Record<string, string>
  columns: ColumnDef<T>[]
  headerClassNames: Record<string, string>
  nextPageToken: string
  rowHref?: (row: T) => Route
  table: ReturnType<typeof useReactTable<T>>
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="w-full min-w-0 border-b">
        <Table aria-label={ariaLabel} className="w-full table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead className={headerClassNames[header.column.id]} key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                const cells = row.getVisibleCells().map((cell) => (
                  <TableCell
                    className={[
                      cellClassNames[cell.column.id],
                      ["ownedAgents", "sharedAgents", "apiKeys", "action", "actions"].includes(
                        cell.column.id
                      )
                        ? "text-right tabular-nums"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={cell.id}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))
                const href = rowHref?.(row.original)
                return href ? (
                  <RoutedTableRow aria-label={`Open ${row.id}`} href={href} key={row.id}>
                    {cells}
                  </RoutedTableRow>
                ) : (
                  <TableRow key={row.id}>{cells}</TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={columns.length}>
                  <EmptyValue />
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

function AssignmentSummary({ roles, teams }: { roles: string[]; teams: string[] }) {
  return (
    <span className="text-sm whitespace-nowrap tabular-nums">
      Roles: {roles.length} <span className="text-muted-foreground">·</span> Teams: {teams.length}
    </span>
  )
}
