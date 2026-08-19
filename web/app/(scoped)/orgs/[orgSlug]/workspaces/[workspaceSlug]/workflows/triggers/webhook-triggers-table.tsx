"use client"

import * as React from "react"
import type { Route } from "next"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TokenTablePagination } from "@/components/table-pagination"
import { Badge } from "@/components/ui/badge"
import { RelativeDateTime } from "@/components/ui/table"

export type WebhookTriggerRow = {
  apiKeyID: string
  apiKeyDisplay: string
  apiKeyName?: string
  deleted: boolean
  lastTriggeredAt: string
  workflowName: string
}

const layout: Record<string, AdminColumnLayout> = {
  api_key: { minWidth: 256, contentMaxWidth: 352 },
  workflow_name: { minWidth: 192, contentMaxWidth: 288 },
  last_triggered: { minWidth: 160, width: 160 },
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

  const columns = React.useMemo<ColumnDef<WebhookTriggerRow>[]>(
    () => [
      {
        id: "api_key",
        header: "API key",
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
        header: "Last triggered",
        cell: ({ row }) => <RelativeDateTime value={row.original.lastTriggeredAt} />,
      },
    ],
    []
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  return (
    <AdminDataGrid
      ariaLabel="Webhook triggers"
      emptyState={<p className="text-muted-foreground py-8 text-center">No webhooks found.</p>}
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(row) =>
        `${basePath}/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=webhook&workflow_name=${encodeURIComponent(row.workflowName)}&webhook_api_key_id=${encodeURIComponent(row.apiKeyID)}` as Route
      }
      rows={rows}
      table={table}
    />
  )
}
