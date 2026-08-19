"use client"

import * as React from "react"
import { experimental_streamedQuery as streamedQuery } from "@tanstack/react-query"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { getCoreRowModel, type SortingState, useReactTable } from "@tanstack/react-table"
import {
  watchSecrets,
  type SecretListItem,
  type SecretSortByQuery,
  type SortOrderQuery,
  type WatchSecretsEvent,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { TokenTablePagination } from "@/components/table-pagination"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { createSecretColumns } from "./secret-columns"
import type { DeleteSecretFormAction } from "@/data/types"
import { useServerSorting } from "@/lib/use-token-pagination"

const layout: Record<string, AdminColumnLayout> = {
  key: { minWidth: 192, contentMaxWidth: 288 },
  type: { minWidth: 96, width: 96 },
  status: { minWidth: 112, width: 112 },
  hosts: { minWidth: 192, contentMaxWidth: 320 },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  age: { minWidth: 112, width: 112 },
  actions: { minWidth: 64, width: 64 },
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
  canCreate,
  secrets,
  hasNextPage,
  nextPageToken,
  deleteSecretAction,
  canDelete,
  workspaceId,
  sortBy,
  sortOrder,
}: {
  agentName: string
  canCreate: boolean
  secrets: SecretListItem[]
  hasNextPage: boolean
  nextPageToken: string
  deleteSecretAction: DeleteSecretFormAction
  canDelete: boolean
  workspaceId: string
  sortBy: SecretSortByQuery
  sortOrder: SortOrderQuery
}) {
  "use no memo"

  const sorting: SortingState = [
    { id: sortBy === "created_at" ? "age" : "key", desc: sortOrder === "desc" },
  ]
  const { onSortingChange } = useServerSorting({
    fields: { age: "created_at", key: "key" } satisfies Record<string, SecretSortByQuery>,
    pageTokenKey: "page_token",
    sorting,
    tokenStackKey: "token_stack",
  })

  const query = useQuery(watchSecretsQueryOptions(agentName, workspaceId, secrets))
  const rows = query.data ?? secrets
  const columns = React.useMemo(
    () => createSecretColumns(agentName, deleteSecretAction, canDelete),
    [agentName, deleteSecretAction, canDelete]
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
    <AdminDataGrid
      ariaLabel="Secrets"
      emptyState={
        <AdministrationState
          description="Store credentials for an Agent and restrict which hosts may receive them."
          kind={canCreate ? "welcome" : "empty"}
          title="Let's add your first secret"
        />
      }
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rows={rows}
      table={table}
    />
  )
}
