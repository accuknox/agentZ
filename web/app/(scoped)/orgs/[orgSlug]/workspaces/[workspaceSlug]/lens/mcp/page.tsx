import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { AdministrationPageHeader } from "@/components/administration"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getMcpGraphAction } from "@/data/lens.actions"
import type { ListAgentActionResponse } from "@/data/types"
import {
  McpEmptyState,
  McpGraph,
  McpGraphSkeleton,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/mcp/mcp-graph"
import { LensFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/lens-filters"
import { lensDateRange } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/search-params"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata: Metadata = {
  title: "MCP Observability",
}

const mcpSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  from: searchParamStringSchema,
  to: searchParamStringSchema,
})

type McpSearchParams = {
  agent_name?: SearchParamStringInput
  from?: SearchParamStringInput
  to?: SearchParamStringInput
}

type McpScope =
  | {
      agents: NonNullable<ListAgentActionResponse["agents"]>
      selectedAgentName?: string
      error: undefined
    }
  | {
      agents: undefined
      selectedAgentName?: undefined
      error: NonNullable<ListAgentActionResponse["error"]>
    }

/**
 * McpPage renders MCP observability for one selected agent and date range.
 */
export default async function McpPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<McpSearchParams>
}) {
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind !== "ready") {
    return <ErrorPanel message="Workspace is unavailable" />
  }
  if (!workspace.workspace.capabilities.observability.read) {
    return <ErrorPanel message="You do not have Lens access in this Workspace" />
  }

  const resolved = resolveMcpSearchParams(searchParams)
  const workspaceId = workspace.workspace.id

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="MCP Observability" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <Suspense
          fallback={
            <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
              <Skeleton className="h-8 w-full sm:w-64" />
              <Skeleton className="h-8 w-full sm:w-72" />
            </div>
          }
        >
          <Filters searchParams={resolved} workspaceId={workspaceId} />
        </Suspense>
        <Suspense fallback={<McpGraphSkeleton />}>
          <Graph searchParams={resolved} workspaceId={workspaceId} />
        </Suspense>
      </div>
    </main>
  )
}

async function Filters({
  searchParams,
  workspaceId,
}: {
  searchParams: Promise<ResolvedMcpSearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const range = params.range
  const scope = await getMcpScope({
    agents: listAgentsCachedQuery(undefined, workspaceId),
    agentName: params.agentName,
  })
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  return (
    <LensFilters
      agents={scope.agents}
      selectedAgentName={scope.selectedAgentName}
      from={range.from}
      to={range.to}
    />
  )
}

async function Graph({
  searchParams,
  workspaceId,
}: {
  searchParams: Promise<ResolvedMcpSearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const range = params.range
  const scope = await getMcpScope({
    agents: listAgentsCachedQuery(undefined, workspaceId),
    agentName: params.agentName,
  })

  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.selectedAgentName) {
    if (params.agentName && scope.agents.length > 0) {
      return <EmptyState message="The selected agent is no longer accessible" />
    }
    return <EmptyState message="No agents available" />
  }

  const result = await getMcpGraphAction(
    { agentName: scope.selectedAgentName },
    { from: range.from, to: range.to },
    workspaceId
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  if (result.data.connections.length === 0) {
    return <McpEmptyState agentName={result.data.agent.name} />
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1">
      <McpGraph
        key={[
          result.data.agent.name,
          range.from,
          range.to,
          result.data.connections.length,
          result.data.tools.length,
          result.data.edges.length,
        ].join(":")}
        graph={result.data}
      />
    </section>
  )
}

type ResolvedMcpSearchParams = {
  agentName?: string
  range: ReturnType<typeof lensDateRange>
}

async function resolveMcpSearchParams(
  searchParams: Promise<McpSearchParams>
): Promise<ResolvedMcpSearchParams> {
  const params = mcpSearchParamsSchema.parse(await searchParams)

  return {
    agentName: params.agent_name,
    range: lensDateRange(params.from, params.to),
  }
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="bg-destructive/5 text-destructive m-6 rounded-md p-4 text-sm">{message}</div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}

async function getMcpScope({
  agents,
  agentName,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
}): Promise<McpScope> {
  const result = await agents
  if (result.error) {
    return {
      agents: undefined,
      selectedAgentName: undefined,
      error: result.error,
    }
  }

  const selectedAgentName = agentName
    ? result.agents.find((agent) => agent.name === agentName)?.name
    : result.agents[0]?.name

  return {
    agents: result.agents,
    selectedAgentName,
    error: undefined,
  }
}
