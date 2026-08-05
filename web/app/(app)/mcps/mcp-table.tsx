"use client"

import * as React from "react"
import { experimental_streamedQuery as streamedQuery } from "@tanstack/react-query"
import { queryOptions, useQuery } from "@tanstack/react-query"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  watchMcpConnections,
  type McpConnectionSummary,
  type WatchMcpConnectionsEvent,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { useTokenPagination } from "@/app/(app)/lens/traces/client-utils"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { DeleteMcpFormState } from "@/data/mcp.actions"
import { createMcpColumns } from "./mcp-columns"
import { McpViewSheet } from "./mcp-view-sheet"
import { ArrowLeft, ArrowRight } from "lucide-react"

const columnClassName: Record<string, string> = {
  name: "w-40",
  auth_mode: "w-32",
  status: "w-48",
  endpoint: "min-w-0 w-0",
  age: "w-28",
  actions: "w-14",
}

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
        const byName = new Map(rows.map((row) => [row.name, row]))

        for (const connection of event.mcp_connections) {
          if (!byName.has(connection.name)) {
            continue
          }
          byName.set(connection.name, connection)
        }

        return rows.map((row) => byName.get(row.name) ?? row)
      },
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchMcpConnections({
          baseUrl: await getGatewayBaseURL(),
          body: {
            names: connectionNames,
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
  mcpConnections,
  hasNextPage,
  nextPageToken,
  deleteMcpAction,
  scopeLabel,
  workspaceId,
}: {
  mcpConnections: McpConnectionSummary[]
  hasNextPage: boolean
  nextPageToken: string
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
  scopeLabel?: "Local" | `Inherited from ${string}`
  workspaceId?: string
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([{ id: "age", desc: true }])
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()
  const [viewConnectionName, setViewConnectionName] = React.useState<string>()
  const connectionNames = React.useMemo(
    () => mcpConnections.map((connection) => connection.name),
    [mcpConnections]
  )
  const query = useQuery(
    watchMcpConnectionsQueryOptions(connectionNames, mcpConnections, workspaceId)
  )
  const rows = query.data ?? mcpConnections
  const columns = React.useMemo(
    () =>
      createMcpColumns({
        deleteMcpAction,
        scopeLabel,
        onViewAction: setViewConnectionName,
      }),
    [deleteMcpAction, scopeLabel]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  })

  return (
    <div className="min-w-0 space-y-4">
      <div className="w-full min-w-0 border-b">
        <Table className="table-auto">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={`h-8 ${columnClassName[header.column.id] ?? "px-4"}`}
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
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setViewConnectionName(row.original.name)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") {
                      return
                    }

                    event.preventDefault()
                    setViewConnectionName(row.original.name)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`h-11 py-2 align-middle ${columnClassName[cell.column.id] ?? "px-4"}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No MCP connections
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 px-2">
        <Button variant="ghost" size="sm" onClick={goPrevious} disabled={!canGoPrevious || pending}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goNext(nextPageToken)}
          disabled={!hasNextPage || pending}
        >
          Next
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
      {viewConnectionName ? (
        <McpViewSheet
          name={viewConnectionName}
          workspaceId={workspaceId}
          open
          onOpenChangeAction={(open) => {
            if (!open) {
              setViewConnectionName(undefined)
            }
          }}
        />
      ) : null}
    </div>
  )
}
