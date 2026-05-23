import { Suspense } from "react"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import {
  getTraceChartAction,
  listTraceSessionFilterAction,
  listTraceSessionsAction,
} from "@/data/lens.actions"
import type { ListAgentActionResponse, TraceSessionFilterItem } from "@/data/types"
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
  session_id?: string | string[]
  from?: string | string[]
  to?: string | string[]
  page_token?: string | string[]
  limit?: string | string[]
}

type TraceScopeSuccess = {
  agents: NonNullable<ListAgentActionResponse["agents"]>
  sessions: TraceSessionFilterItem[]
  selectedAgentName?: string
  selectedSessionId?: string
  error: undefined
}

type TraceScopeFailure = {
  agents: undefined
  sessions: undefined
  selectedAgentName?: undefined
  selectedSessionId?: undefined
  error: NonNullable<ListAgentActionResponse["error"]>
}

type TraceScope = TraceScopeSuccess | TraceScopeFailure

function traceScopeFailure(
  error: NonNullable<ListAgentActionResponse["error"]>
): TraceScopeFailure {
  return {
    agents: undefined,
    sessions: undefined,
    selectedAgentName: undefined,
    selectedSessionId: undefined,
    error,
  }
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
  const sessionID = firstSearchParam(params.session_id)
  const traceScope = getTraceScope({
    agents,
    agentName,
    sessionID,
  })

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<TracesFiltersSkeleton />}>
        <Filters traceScope={traceScope} from={range.from} to={range.to} />
      </Suspense>
      <Suspense
        key={`chart-${agentName ?? "default"}-${sessionID ?? "default"}-${range.startedAfter}-${range.startedBefore}`}
        fallback={<TracesChartSkeleton />}
      >
        <Chart traceScope={traceScope} range={range} />
      </Suspense>
      <Suspense
        key={`table-${agentName ?? "default"}-${sessionID ?? "default"}-${range.startedAfter}-${range.startedBefore}-${pageToken ?? ""}-${limit}`}
        fallback={<TracesSkeleton />}
      >
        <Traces traceScope={traceScope} range={range} pageToken={pageToken} limit={limit} />
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
  traceScope,
  from,
  to,
}: {
  traceScope: Promise<TraceScope>
  from?: string
  to?: string
}) {
  const scope = await traceScope
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  return (
    <TracesFilters
      agents={scope.agents}
      sessions={scope.sessions}
      selectedAgentName={scope.selectedAgentName}
      selectedSessionId={scope.selectedSessionId}
      from={from}
      to={to}
    />
  )
}

async function Chart({
  traceScope,
  range,
}: {
  traceScope: Promise<TraceScope>
  range: TraceDateRange
}) {
  const scope = await traceScope
  if (scope.error) {
    return null
  }

  if (!scope.selectedAgentName) {
    return null
  }

  const result = await getTraceChartAction({
    agent_name: scope.selectedAgentName,
    session_id: scope.selectedSessionId,
    started_after: range.startedAfter,
    started_before: range.startedBefore,
  })
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TracesChart data={result.data} />
}

async function Traces({
  traceScope,
  range,
  pageToken,
  limit,
}: {
  traceScope: Promise<TraceScope>
  range: TraceDateRange
  pageToken?: string
  limit: number
}) {
  const scope = await traceScope
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.selectedAgentName || !scope.selectedSessionId) {
    return <TracesTable data={undefined} error={undefined} />
  }

  const result = await listTraceSessionsAction({
    agent_name: scope.selectedAgentName,
    session_id: scope.selectedSessionId,
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

async function getTraceScope({
  agents,
  agentName,
  sessionID,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  sessionID?: string
}): Promise<TraceScope> {
  const agentResult = await agents
  if (agentResult.error) {
    return traceScopeFailure(agentResult.error)
  }

  const selectedAgentName = agentResult.agents.some((agent) => agent.name === agentName)
    ? agentName
    : agentResult.agents[0]?.name
  if (!selectedAgentName) {
    return {
      agents: agentResult.agents,
      sessions: [],
      selectedAgentName: undefined,
      selectedSessionId: undefined,
      error: undefined,
    }
  }

  const sessionResult = await listTraceSessionFilterAction({
    agent_name: selectedAgentName,
  })
  if (sessionResult.error) {
    return traceScopeFailure(sessionResult.error)
  }

  const selectedSessionId = sessionResult.data.some((session) => session.sessionId === sessionID)
    ? sessionID
    : sessionResult.data[0]?.sessionId

  return {
    agents: agentResult.agents,
    sessions: sessionResult.data,
    selectedAgentName,
    selectedSessionId,
    error: undefined,
  }
}
