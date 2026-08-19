"use client"

import * as React from "react"
import { experimental_streamedQuery as streamedQuery } from "@tanstack/react-query"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { getCoreRowModel, type SortingState, useReactTable } from "@tanstack/react-table"
import {
  watchMcpConnections,
  type McpConnectionSummary,
  type ResourceSortByQuery,
  type SortOrderQuery,
  type WatchMcpConnectionsEvent,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { TokenTablePagination } from "@/components/table-pagination"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import type { DeleteMcpFormState } from "@/data/mcp.actions"
import { createMcpColumns } from "./mcp-columns"
import { McpViewSheet } from "./mcp-view-sheet"
import { useServerSorting } from "@/lib/use-token-pagination"

const columnLayout = {
  name: { minWidth: 224 },
  auth_mode: { minWidth: 96, width: 96 },
  status: { minWidth: 112, width: 112 },
  endpoint: { contentMaxWidth: 320, minWidth: 200 },
  created_by: { minWidth: 96, width: 96 },
  last_modified_by: { minWidth: 104, width: 104 },
  age: { minWidth: 104, width: 104 },
  actions: { align: "end", minWidth: 64, width: 64 },
} satisfies Record<string, AdminColumnLayout>

const watchMcpConnectionsQueryOptions = (
  connectionNames: string[],
  mcpConnections: McpConnectionSummary[],
  workspaceId?: string
) =>
  queryOptions({
    queryKey: ["watchMcpConnections", workspaceId, connectionNames] as const,
    enabled: connectionNames.length > 0,
    placeholderData: mcpConnections,
    queryFn: streamedQuery<
      WatchMcpConnectionsEvent,
      McpConnectionSummary[],
      readonly ["watchMcpConnections", string | undefined, string[]]
    >({
      initialValue: mcpConnections,
      reducer: (rows, event) => {
        const byReference = new Map(rows.map((row) => [JSON.stringify([row.scope, row.name]), row]))

        for (const connection of event.mcp_connections) {
          const reference = JSON.stringify([connection.scope, connection.name])
          if (!byReference.has(reference)) {
            continue
          }
          byReference.set(reference, connection)
        }

        return rows.map((row) => byReference.get(JSON.stringify([row.scope, row.name])) ?? row)
      },
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchMcpConnections({
          baseUrl: await getGatewayBaseURL(),
          body: {
            connections: connectionNames.map((name) => ({
              name,
              scope: workspaceId ? "Workspace" : "Organisation",
            })),
          },
          signal,
          headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
        })
        return result.stream
      },
    }),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })

export function McpTable({
  canCreate,
  mcpConnections,
  hasNextPage,
  nextPageToken,
  deleteMcpAction,
  workspaceId,
  sortBy,
  sortOrder,
}: {
  canCreate: boolean
  mcpConnections: McpConnectionSummary[]
  hasNextPage: boolean
  nextPageToken: string
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
  workspaceId?: string
  sortBy: ResourceSortByQuery
  sortOrder: SortOrderQuery
}) {
  "use no memo"

  const sorting: SortingState = [
    { id: sortBy === "created_at" ? "age" : "name", desc: sortOrder === "desc" },
  ]
  const { onSortingChange } = useServerSorting({
    fields: { age: "created_at", name: "name" } satisfies Record<string, ResourceSortByQuery>,
    pageTokenKey: "page_token",
    sorting,
    tokenStackKey: "token_stack",
  })

  const [viewConnection, setViewConnection] = React.useState<McpConnectionSummary>()
  const connectionNames = React.useMemo(
    () =>
      mcpConnections
        .filter((connection) => connection.scope === (workspaceId ? "Workspace" : "Organisation"))
        .map((connection) => connection.name),
    [mcpConnections, workspaceId]
  )
  const query = useQuery(
    watchMcpConnectionsQueryOptions(connectionNames, mcpConnections, workspaceId)
  )
  const rows = query.data ?? mcpConnections
  const columns = React.useMemo(
    () =>
      createMcpColumns({
        deleteMcpAction,
        showOrganization: workspaceId !== undefined,
        onViewAction: setViewConnection,
      }),
    [deleteMcpAction, workspaceId]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    onSortingChange,
    state: { sorting },
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AdminDataGrid
        ariaLabel="MCP connections"
        emptyState={
          <AdministrationState
            description={
              canCreate
                ? "Connect an MCP server, then choose which of its tools Agents may use."
                : "There are no MCP connections available in this scope."
            }
            kind={canCreate ? "welcome" : "empty"}
            title="Let's connect your tools"
          />
        }
        layout={columnLayout}
        pagination={
          <TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />
        }
        rows={rows}
        table={table}
      />
      {viewConnection ? (
        <McpViewSheet
          name={viewConnection.name}
          scope={viewConnection.scope}
          workspaceId={workspaceId}
          open
          onOpenChangeAction={(open) => {
            if (!open) {
              setViewConnection(undefined)
            }
          }}
        />
      ) : null}
    </div>
  )
}
