"use client"

import * as React from "react"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { Sandbox } from "@/lib/gateway/client"
import { createSandboxColumns } from "./sandbox-columns"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TokenTablePagination } from "@/components/table-pagination"
import type { DeleteSandboxFormState } from "@/data/types"
import type { Route } from "next"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 208, contentMaxWidth: 288, pin: "start" },
  packages: { minWidth: 96, width: 96 },
  allowed_hosts: { minWidth: 96, width: 96 },
  models: { minWidth: 128, width: 128 },
  mcps: { minWidth: 64, width: 64 },
  skills: { minWidth: 80, width: 80 },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  created_at: { minWidth: 112, width: 112 },
  actions: { minWidth: 64, width: 64, pin: "end" },
}

export function SandboxTable({
  sandboxes,
  basePath,
  hasNextPage,
  nextPageToken,
  deleteSandboxAction,
  showOrganization,
}: {
  sandboxes: Sandbox[]
  basePath: string
  hasNextPage: boolean
  nextPageToken: string
  showOrganization: boolean
  deleteSandboxAction: (
    name: string,
    state: DeleteSandboxFormState,
    formData: FormData
  ) => Promise<DeleteSandboxFormState>
}) {
  "use no memo"

  const columns = React.useMemo(
    () => createSandboxColumns(basePath, deleteSandboxAction, showOrganization),
    [basePath, deleteSandboxAction, showOrganization]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: sandboxes,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <AdminDataGrid
      ariaLabel="Sandboxes"
      emptyState={<p className="text-muted-foreground py-8 text-center">No sandboxes found.</p>}
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
