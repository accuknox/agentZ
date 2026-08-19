"use client"

import * as React from "react"
import type { Route } from "next"
import { getCoreRowModel, type SortingState, useReactTable } from "@tanstack/react-table"
import type {
  Agent,
  ResourceSortByQuery,
  Sandbox,
  Skill,
  SortOrderQuery,
} from "@/lib/gateway/client"
import { createAgentColumns } from "@/app/agent-columns"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import type { AgentActionScope } from "@/data/agent.actions"
import type { DeleteAgentFormState } from "@/data/types"
import { useServerSorting } from "@/lib/use-token-pagination"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  created_at: { minWidth: 128, width: 128 },
  actions: { minWidth: 64, width: 64 },
}

export function AgentTable({
  agents,
  canCreate,
  immutableSkills,
  sandboxes,
  hasNextPage,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  nextPageToken,
  sortBy,
  sortOrder,
  deleteAgentAction,
  actionScope,
}: {
  agents: Agent[]
  canCreate: boolean
  immutableSkills: Skill[]
  sandboxes: Sandbox[]
  hasNextPage: boolean
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  nextPageToken: string
  sortBy: ResourceSortByQuery
  sortOrder: SortOrderQuery
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
  actionScope: AgentActionScope
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
    manualPagination: true,
    manualSorting: true,
    onSortingChange,
    state: { sorting },
  })

  return (
    <AdminDataGrid
      ariaLabel="Agents"
      emptyState={
        <AdministrationState
          description="Create an agent and give it a sandbox, skills, and tools."
          kind={canCreate ? "welcome" : "empty"}
          title="Let's create your first agent"
        />
      }
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(agent) =>
        `${actionScope.workspacePath}/agents/${encodeURIComponent(agent.name)}` as Route
      }
      rows={agents}
      table={table}
    />
  )
}
