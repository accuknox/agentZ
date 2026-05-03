import { Suspense } from "react"
import { listAgentsAction } from "@/data/agent.actions"
import { getTraceChartAction, listTracesAction } from "@/data/lens.actions"
import type { ListAgentActionResponse, ListAgentWithConfigActionResponse } from "@/data/types"
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
  session_id?: string | string[]
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
  const agents = listAgentsAction(true)
  const from = firstSearchParam(params.from)
  const to = firstSearchParam(params.to)
  const range = traceDateRange(from, to)
  const pageToken = firstSearchParam(params.page_token)
  const limit = parseLimitParam(firstSearchParam(params.limit))
  const sessionID = firstSearchParam(params.session_id)

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<TracesFiltersSkeleton />}>
        <Filters agents={agents} sessionID={sessionID} from={range.from} to={range.to} />
      </Suspense>
      <Suspense
        key={`chart-${sessionID ?? "default"}-${range.startedAfter}-${range.startedBefore}`}
        fallback={<TracesChartSkeleton />}
      >
        <Chart agents={agents} sessionID={sessionID} range={range} />
      </Suspense>
      <Suspense
        key={`table-${sessionID ?? "default"}-${range.startedAfter}-${range.startedBefore}-${pageToken ?? ""}-${limit}`}
        fallback={<TracesSkeleton />}
      >
        <Traces
          agents={agents}
          sessionID={sessionID}
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
  sessionID,
  from,
  to,
}: {
  agents: Promise<ListAgentWithConfigActionResponse>
  sessionID?: string
  from?: string
  to?: string
}) {
  const result = await agents
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <TracesFilters
      agents={result.agents}
      selectedSessionID={selectedSessionID(result, sessionID)}
      from={from}
      to={to}
    />
  )
}

async function Chart({
  agents,
  sessionID,
  range,
}: {
  agents: Promise<ListAgentWithConfigActionResponse>
  sessionID?: string
  range: TraceDateRange
}) {
  const agentsResult = await agents
  const selected = selectedSessionID(agentsResult, sessionID)
  if (agentsResult.error) {
    return null
  }

  if (!selected) {
    return null
  }

  const result = await getTraceChartAction({
    session_id: selected,
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
  sessionID,
  range,
  pageToken,
  limit,
}: {
  agents: Promise<ListAgentWithConfigActionResponse>
  sessionID?: string
  range: TraceDateRange
  pageToken?: string
  limit: number
}) {
  const agentsResult = await agents
  const selected = selectedSessionID(agentsResult, sessionID)
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  if (!selected) {
    return <TracesTable data={undefined} error={undefined} />
  }

  const result = await listTracesAction({
    session_id: selected,
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

function selectedSessionID(result: ListAgentActionResponse, sessionID?: string) {
  if (result.error) {
    return undefined
  }

  return sessionID ?? result.agents[0]?.session_id
}
