"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { flexRender, getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { TokenTablePagination } from "@/components/table-pagination"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRelativeTime,
  TableRow,
} from "@/components/ui/table"

export type WebhookTriggerRow = {
  apiKeyID: string
  apiKeyDisplay: string
  apiKeyName?: string
  deleted: boolean
  lastTriggeredAt: string
  workflowName: string
}

const columnClassName: Record<string, string> = {
  api_key: "min-w-64",
  last_triggered: "w-40",
  workflow_name: "min-w-48",
}

export function WebhookTriggersTable({
  agentName,
  basePath,
  hasNextPage,
  nextPageToken,
  rows,
}: {
  agentName: string
  basePath: string
  hasNextPage: boolean
  nextPageToken: string
  rows: WebhookTriggerRow[]
}) {
  "use no memo"

  const router = useRouter()
  const columns = React.useMemo<ColumnDef<WebhookTriggerRow>[]>(
    () => [
      {
        id: "api_key",
        header: "API Key",
        cell: ({ row }) => (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{row.original.apiKeyName || "Deleted key"}</span>
              {row.original.deleted ? <Badge variant="outline">Deleted</Badge> : null}
            </div>
            <code className="text-muted-foreground text-xs">{row.original.apiKeyDisplay}</code>
          </div>
        ),
      },
      {
        accessorKey: "workflowName",
        id: "workflow_name",
        header: "Workflow",
        cell: ({ row }) => <span className="font-mono text-sm">{row.original.workflowName}</span>,
      },
      {
        accessorKey: "lastTriggeredAt",
        id: "last_triggered",
        header: "Last Triggered",
        cell: ({ row }) => <TableRelativeTime value={row.original.lastTriggeredAt} />,
      },
    ],
    []
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  function open(row: WebhookTriggerRow) {
    router.push(
      `${basePath}/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=webhook&workflow_name=${encodeURIComponent(row.workflowName)}&webhook_api_key_id=${encodeURIComponent(row.apiKeyID)}`
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table className="table-auto">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    className={`h-8 px-4 ${columnClassName[header.column.id]}`}
                    key={header.id}
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
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  role="link"
                  tabIndex={0}
                  onClick={() => open(row.original)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return

                    event.preventDefault()
                    open(row.original)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      className={`h-11 px-4 py-1.5 ${columnClassName[cell.column.id]}`}
                      key={cell.id}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center">
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
