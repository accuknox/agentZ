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
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useTokenPagination } from "@/app/(app)/lens/traces/client-utils"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { createSecretColumns } from "./secret-columns"
import type { DeleteSecretFormAction } from "@/data/types"

const columnClassName: Record<string, string> = {
  key: "w-[29%]",
  type: "w-[8%]",
  status: "w-[10%]",
  hosts: "w-[26%]",
  age: "w-[24%]",
  actions: "w-[3%]",
}

const watchSecretsQueryOptions = (agentName: string, secrets: SecretListItem[]) =>
  queryOptions({
    queryKey: ["watchSecrets", agentName, secrets.map((secret) => secret.key)] as const,
    enabled: secrets.length > 0,
    placeholderData: secrets,
    queryFn: streamedQuery<
      WatchSecretsEvent,
      SecretListItem[],
      readonly ["watchSecrets", string, string[]]
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
}: {
  agentName: string
  secrets: SecretListItem[]
  hasNextPage: boolean
  nextPageToken: string
  deleteSecretAction: DeleteSecretFormAction
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()
  const query = useQuery(watchSecretsQueryOptions(agentName, secrets))
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
    <div className="min-w-0 space-y-4">
      <div className="w-full min-w-0 overflow-hidden border-b">
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
    </div>
  )
}
