import { Suspense } from "react"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { getTraceChartAction, listTracesAction } from "@/data/lens.actions"
import type { ListAgentActionResponse } from "@/data/types"
import { TracesChart } from "@/app/lens/traces/traces-chart"
import { TracesChartSkeleton } from "@/app/lens/traces/traces-chart-skeleton"
import { TracesFilters } from "@/app/lens/traces/traces-filters"
import {
  firstSearchParam,
  parseLimitParam,
  type TraceDateRange,
  traceDateRange,
} from "@/app/lens/traces/search-params"
import { TracesSkeleton } from "@/app/lens/traces/traces-skeleton"
import { TracesTable } from "@/app/lens/traces/traces-table"

type TracesSearchParams = {
  agent_name?: string | string[]
  from?: string | string[]
  to?: string | string[]
  page_token?: string | string[]
  limit?: string | string[]
}

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<TracesSearchParams>
}) {
  const params = await searchParams
  const agents = listAgentsCachedQuery()
  const from = firstSearchParam(params.from)
  const to = firstSearchParam(params.to)
  const range = traceDateRange(from, to)
  const pageToken = firstSearchParam(params.page_token)
  const limit = parseLimitParam(firstSearchParam(params.limit))
  const agentName = firstSearchParam(params.agent_name)

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<TracesFiltersSkeleton />}>
        <Filters agents={agents} agentName={agentName} from={range.from} to={range.to} />
      </Suspense>
      <Suspense
        key={`chart-${agentName ?? "default"}-${range.startedAfter}-${range.startedBefore}`}
        fallback={<TracesChartSkeleton />}
      >
        <Chart agents={agents} agentName={agentName} range={range} />
      </Suspense>
      <Suspense
        key={`table-${agentName ?? "default"}-${range.startedAfter}-${range.startedBefore}-${pageToken ?? ""}-${limit}`}
        fallback={<TracesSkeleton />}
      >
        <Traces
          agents={agents}
          agentName={agentName}
          range={range}
          pageToken={pageToken}
          limit={limit}
        />
      </Suspense>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex items-center justify-between px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">Traces</h1>
      </div>
    </div>
  )
}

async function Filters({
  agents,
  agentName,
  from,
  to,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  from?: string
  to?: string
}) {
  const result = await agents
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  const selected = agentName ?? result.agents[0]?.name

  return <TracesFilters agents={result.agents} selectedAgentName={selected} from={from} to={to} />
}

async function Chart({
  agents,
  agentName,
  range,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  range: TraceDateRange
}) {
  const agentsResult = await agents
  if (agentsResult.error) {
    return null
  }

  const selected = agentName ?? agentsResult.agents[0]?.name
  if (!selected) {
    return null
  }

  const result = await getTraceChartAction({
    agent_name: selected,
    started_after: range.startedAfter,
    started_before: range.startedBefore,
  })
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TracesChart data={result.data} />
}

async function Traces({
  agents,
  agentName,
  range,
  pageToken,
  limit,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  range: TraceDateRange
  pageToken?: string
  limit: number
}) {
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selected = agentName ?? agentsResult.agents[0]?.name
  if (!selected) {
    return <TracesTable data={undefined} error={undefined} />
  }

  const result = await listTracesAction({
    agent_name: selected,
    limit,
    page_token: pageToken,
    started_after: range.startedAfter,
    started_before: range.startedBefore,
  })

  return <TracesTable data={result.data} error={result.error} />
}

function TracesFiltersSkeleton() {
  return <div className="h-15 border-b bg-muted/20" />
}

function ErrorPanel({ message }: { message: string }) {
  return <div className="rounded-md bg-destructive/5 p-4 text-sm text-destructive">{message}</div>
}
