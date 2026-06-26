import type { Metadata } from "next"
import { Suspense } from "react"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getMcpGraphAction } from "@/data/lens.actions"
import type { ListAgentActionResponse } from "@/data/types"
import { McpEmptyState, McpGraph } from "@/app/(app)/lens/mcp/mcp-graph"
import { McpFilters } from "@/app/(app)/lens/mcp/mcp-filters"
import { mcpDateRange } from "@/app/(app)/lens/mcp/search-params"

export const metadata: Metadata = {
  title: "MCP Observability",
}

type McpSearchParams = {
  agent_name?: string | string[]
  from?: string | string[]
  to?: string | string[]
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
  searchParams,
}: {
  searchParams: Promise<McpSearchParams>
}) {
  const agents = listAgentsCachedQuery()

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<FiltersSkeleton />}>
        <FiltersContent agents={agents} searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<GraphSkeleton />}>
        <GraphContent agents={agents} searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex items-center justify-between px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">MCP Observability</h1>
      </div>
    </div>
  )
}

async function Filters({
  scope,
  from,
  to,
}: {
  scope: Promise<McpScope>
  from: string
  to: string
}) {
  const resolvedScope = await scope
  if (resolvedScope.error) {
    return <ErrorPanel message={resolvedScope.error.message} />
  }

  return (
    <McpFilters
      agents={resolvedScope.agents}
      selectedAgentName={resolvedScope.selectedAgentName}
      from={from}
      to={to}
    />
  )
}

async function FiltersContent({
  agents,
  searchParams,
}: {
  agents: Promise<ListAgentActionResponse>
  searchParams: Promise<McpSearchParams>
}) {
  const params = await searchParams
  const from = Array.isArray(params.from) ? params.from[0] : params.from
  const to = Array.isArray(params.to) ? params.to[0] : params.to
  const range = mcpDateRange(from, to)
  const scope = getMcpScope({
    agents,
    agentName: Array.isArray(params.agent_name) ? params.agent_name[0] : params.agent_name,
  })

  return <Filters scope={scope} from={range.from} to={range.to} />
}

async function Graph({
  scope,
  range,
}: {
  scope: Promise<McpScope>
  range: ReturnType<typeof mcpDateRange>
}) {
  const resolvedScope = await scope
  if (resolvedScope.error) {
    return <ErrorPanel message={resolvedScope.error.message} />
  }

  if (!resolvedScope.selectedAgentName) {
    return <EmptyState message="No agents available" />
  }

  const result = await getMcpGraphAction(
    { agentName: resolvedScope.selectedAgentName },
    { from: range.from, to: range.to }
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  if (result.data.connections.length === 0) {
    return <McpEmptyState agentName={result.data.agent.name} />
  }

  return (
    <section className="flex min-h-0 flex-1">
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

async function GraphContent({
  agents,
  searchParams,
}: {
  agents: Promise<ListAgentActionResponse>
  searchParams: Promise<McpSearchParams>
}) {
  const params = await searchParams
  const from = Array.isArray(params.from) ? params.from[0] : params.from
  const to = Array.isArray(params.to) ? params.to[0] : params.to
  const range = mcpDateRange(from, to)
  const scope = getMcpScope({
    agents,
    agentName: Array.isArray(params.agent_name) ? params.agent_name[0] : params.agent_name,
  })

  return <Graph scope={scope} range={range} />
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

  const selectedAgentName = result.agents.some((agent) => agent.name === agentName)
    ? agentName
    : result.agents[0]?.name

  return {
    agents: result.agents,
    selectedAgentName,
    error: undefined,
  }
}
