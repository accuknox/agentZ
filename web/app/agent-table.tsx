"use client"

import * as React from "react"
import type { Route } from "next"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { Agent, Sandbox, Skill } from "@/lib/gateway/client"
import { createAgentColumns } from "@/app/agent-columns"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TokenTablePagination } from "@/components/table-pagination"
import type { AgentActionScope } from "@/data/agent.actions"
import type { DeleteAgentFormState } from "@/data/types"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320, pin: "start" },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  created_at: { minWidth: 128, width: 128 },
  actions: { minWidth: 64, width: 64, pin: "end" },
}

export function AgentTable({
  agents,
  immutableSkills,
  sandboxes,
  hasNextPage,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  nextPageToken,
  deleteAgentAction,
  actionScope,
}: {
  agents: Agent[]
  immutableSkills: Skill[]
  sandboxes: Sandbox[]
  hasNextPage: boolean
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  nextPageToken: string
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
  actionScope: AgentActionScope
}) {
  "use no memo"

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
  })

  return (
    <AdminDataGrid
      ariaLabel="Agents"
      emptyState={<p className="text-muted-foreground py-8 text-center">No agents found.</p>}
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
