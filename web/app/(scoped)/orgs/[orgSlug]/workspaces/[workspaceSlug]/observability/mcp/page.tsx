import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getMcpGraphAction } from "@/data/lens.actions"
import type { ListAgentActionResponse } from "@/data/types"
import {
  McpEmptyState,
  McpGraph,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/mcp/mcp-graph"
import { McpFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/mcp/mcp-filters"
import { mcpDateRange } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/mcp/search-params"
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
  if (!workspace.workspace.observability_capabilities.read) {
    return <ErrorPanel message="You do not have Observability access in this Workspace" />
  }

  const resolved = resolveMcpSearchParams(searchParams)
  const workspaceId = workspace.workspace.id

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={resolved} workspaceId={workspaceId} />
      </Suspense>
      <Suspense fallback={<GraphSkeleton />}>
        <Graph searchParams={resolved} workspaceId={workspaceId} />
      </Suspense>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex min-w-0 items-center justify-between px-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">MCP Observability</h1>
      </div>
    </div>
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
    <McpFilters
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
  range: ReturnType<typeof mcpDateRange>
}

async function resolveMcpSearchParams(
  searchParams: Promise<McpSearchParams>
): Promise<ResolvedMcpSearchParams> {
  const params = mcpSearchParamsSchema.parse(await searchParams)

  return {
    agentName: params.agent_name,
    range: mcpDateRange(params.from, params.to),
  }
}

function FiltersSkeleton() {
  return <div className="bg-muted/20 h-15 border-b" />
}

function GraphSkeleton() {
  return (
    <div className="flex flex-1">
      <div className="bg-muted/20 min-h-105 w-full border-y" />
    </div>
  )
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
