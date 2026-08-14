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
import { watchSecrets, type SecretListItem, type WatchSecretsEvent } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { createSecretColumns } from "./secret-columns"
import type { DeleteSecretFormAction } from "@/data/types"

const columnClassName: Record<string, string> = {
  key: "w-56",
  type: "w-24",
  status: "w-28",
  hosts: "min-w-0 w-0",
  age: "w-36",
  actions: "w-14",
}

const watchSecretsQueryOptions = (
  agentName: string,
  workspaceId: string,
  secrets: SecretListItem[]
) =>
  queryOptions({
    queryKey: [
      "watchSecrets",
      workspaceId,
      agentName,
      secrets.map((secret) => secret.key),
    ] as const,
    enabled: secrets.length > 0,
    placeholderData: secrets,
    queryFn: streamedQuery<
      WatchSecretsEvent,
      SecretListItem[],
      readonly ["watchSecrets", string, string, string[]]
    >({
      initialValue: secrets,
      reducer: (rows, event) => {
        const byKey = new Map(rows.map((row) => [row.key, row]))

        for (const secret of event.items) {
          if (!byKey.has(secret.key)) {
            continue
          }
          byKey.set(secret.key, secret)
        }

        return rows.map((row) => byKey.get(row.key) ?? row)
      },
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchSecrets({
          baseUrl: await getGatewayBaseURL(),
          headers: {
            "X-AgentZ-Workspace-ID": workspaceId,
          },
          path: {
            agentName,
          },
          body: {
            keys: secrets.map((secret) => secret.key),
          },
          signal,
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

export function SecretTable({
  agentName,
  secrets,
  hasNextPage,
  nextPageToken,
  deleteSecretAction,
  workspaceId,
}: {
  agentName: string
  secrets: SecretListItem[]
  hasNextPage: boolean
  nextPageToken: string
  deleteSecretAction: DeleteSecretFormAction
  workspaceId: string
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const query = useQuery(watchSecretsQueryOptions(agentName, workspaceId, secrets))
  const rows = query.data ?? secrets
  const columns = React.useMemo(
    () => createSecretColumns(agentName, deleteSecretAction),
    [agentName, deleteSecretAction]
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
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table>
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
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`h-11 px-4 py-1.5 align-middle ${columnClassName[cell.column.id]}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No secrets
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
