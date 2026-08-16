"use client"

import type { Route } from "next"
import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import type { Agent, Sandbox, Skill } from "@/lib/gateway/client"
import { createAgentColumns } from "@/app/agent-columns"
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
import type { AgentActionScope } from "@/data/agent.actions"
import type { DeleteAgentFormState } from "@/data/types"

const columnClassName: Record<string, string> = {
  name: "min-w-40",
  created_by: "hidden lg:table-cell w-28",
  last_modified_by: "hidden lg:table-cell w-28",
  created_at: "w-32",
  actions: "w-20",
}

export function AgentTable({
  agents,
  immutableSkills,
  sandboxes,
  hasNextPage,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  nextPageToken,
  deleteAgentAction,
  actionScope,
}: {
  agents: Agent[]
  immutableSkills: Skill[]
  sandboxes: Sandbox[]
  hasNextPage: boolean
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  nextPageToken: string
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
  actionScope: AgentActionScope
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const columns = React.useMemo(
    () =>
      createAgentColumns(
        deleteAgentAction,
        immutableSkills,
        sandboxes,
        initialHasNextSandboxPage,
        initialNextSandboxPageToken,
        actionScope,
        agents.some((agent) => agent.capabilities.modify || agent.capabilities.delete)
      ),
    [
      deleteAgentAction,
      immutableSkills,
      sandboxes,
      initialHasNextSandboxPage,
      initialNextSandboxPageToken,
      actionScope,
      agents,
    ]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: agents,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table className="w-full table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={`h-8 px-4 ${columnClassName[header.column.id]}`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <RoutedTableRow
                  aria-label={`Open ${row.original.name} settings`}
                  data-state={row.getIsSelected() && "selected"}
                  href={`${actionScope.basePath}/${encodeURIComponent(row.original.name)}` as Route}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`h-11 px-4 py-1.5 ${columnClassName[cell.column.id]}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </RoutedTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
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
