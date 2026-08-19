"use client"

import * as React from "react"
import { getCoreRowModel, type SortingState, useReactTable } from "@tanstack/react-table"
import type { ResourceSortByQuery, Sandbox, SortOrderQuery } from "@/lib/gateway/client"
import { createSandboxColumns } from "./sandbox-columns"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import type { DeleteSandboxFormState } from "@/data/types"
import type { Route } from "next"
import { useServerSorting } from "@/lib/use-token-pagination"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 208, contentMaxWidth: 288 },
  packages: { minWidth: 96, width: 96 },
  allowed_hosts: { minWidth: 96, width: 96 },
  models: { minWidth: 128, width: 128 },
  mcps: { minWidth: 64, width: 64 },
  skills: { minWidth: 80, width: 80 },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  created_at: { minWidth: 112, width: 112 },
  actions: { minWidth: 64, width: 64 },
}

export function SandboxTable({
  sandboxes,
  basePath,
  hasNextPage,
  nextPageToken,
  sortBy,
  sortOrder,
  deleteSandboxAction,
  canCreate,
  showOrganization,
}: {
  sandboxes: Sandbox[]
  basePath: string
  hasNextPage: boolean
  nextPageToken: string
  sortBy: ResourceSortByQuery
  sortOrder: SortOrderQuery
  showOrganization: boolean
  deleteSandboxAction: (
    name: string,
    state: DeleteSandboxFormState,
    formData: FormData
  ) => Promise<DeleteSandboxFormState>
  canCreate: boolean
}) {
  "use no memo"

  const sorting: SortingState = [{ id: sortBy, desc: sortOrder === "desc" }]
  const { onSortingChange } = useServerSorting({
    fields: { name: "name", created_at: "created_at" } satisfies Record<
      string,
      ResourceSortByQuery
    >,
    pageTokenKey: "page_token",
    sorting,
    tokenStackKey: "token_stack",
  })

  const columns = React.useMemo(
    () => createSandboxColumns(basePath, deleteSandboxAction, showOrganization),
    [basePath, deleteSandboxAction, showOrganization]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: sandboxes,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    onSortingChange,
    state: { sorting },
  })

  return (
    <AdminDataGrid
      ariaLabel="Sandboxes"
      emptyState={
        <AdministrationState
          description="Create an isolated environment for your agents and their tools."
          kind={canCreate ? "welcome" : "empty"}
          title="Let's create your first sandbox"
        />
      }
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(sandbox) =>
        sandbox.can_modify
          ? (`${basePath}/update/${encodeURIComponent(sandbox.name)}` as Route)
          : undefined
      }
      rows={sandboxes}
      table={table}
    />
  )
}
