import type { Metadata } from "next"
import { Suspense } from "react"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import {
  getTraceChartAction,
  listTraceSessionFilterAction,
  listTraceSessionsAction,
} from "@/data/lens.actions"
import type { ListAgentActionResponse, TraceSessionFilterItem } from "@/data/types"
import { TracesChart } from "@/app/(app)/lens/traces/traces-chart"
import { TracesChartSkeleton } from "@/app/(app)/lens/traces/traces-chart-skeleton"
import { TracesFilters } from "@/app/(app)/lens/traces/traces-filters"
import {
  firstSearchParam,
  parseLimitParam,
  type TraceDateRange,
  traceDateRange,
} from "@/app/(app)/lens/traces/search-params"
import { TracesSkeleton } from "@/app/(app)/lens/traces/traces-skeleton"
import { TracesTable } from "@/app/(app)/lens/traces/traces-table"

export const metadata: Metadata = {
  title: "Traces",
}

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

export default function TracesPage({
  searchParams,
}: {
  searchParams: Promise<TracesSearchParams>
}) {
  const agents = listAgentsCachedQuery()
  const params = resolveTracesSearchParams(searchParams)
  const traceScope = getTraceScopeFromSearchParams(agents, params)

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<TracesFiltersSkeleton />}>
        <Filters searchParams={params} traceScope={traceScope} />
      </Suspense>
      <Suspense fallback={<TracesChartSkeleton />}>
        <Chart searchParams={params} traceScope={traceScope} />
      </Suspense>
      <Suspense fallback={<TracesSkeleton />}>
        <Traces searchParams={params} traceScope={traceScope} />
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
  searchParams,
  traceScope,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  traceScope: Promise<TraceScope>
}) {
  const [scope, params] = await Promise.all([traceScope, searchParams])
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  return (
    <TracesFilters
      agents={scope.agents}
      sessions={scope.sessions}
      selectedAgentName={scope.selectedAgentName}
      selectedSessionId={scope.selectedSessionId}
      from={params.range.from}
      to={params.range.to}
    />
  )
}

async function Chart({
  searchParams,
  traceScope,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  traceScope: Promise<TraceScope>
}) {
  const [scope, params] = await Promise.all([traceScope, searchParams])
  if (scope.error) {
    return null
  }

  if (!scope.selectedAgentName) {
    return null
  }
  const sessionID = scope.selectedSessionId
  if (!sessionID) {
    return null
  }

  const result = await getTraceChartAction(
    {
      agentName: scope.selectedAgentName,
      sessionID,
    },
    {
      started_after: params.range.startedAfter,
      started_before: params.range.startedBefore,
    }
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TracesChart data={result.data} />
}

async function Traces({
  searchParams,
  traceScope,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  traceScope: Promise<TraceScope>
}) {
  const [scope, params] = await Promise.all([traceScope, searchParams])
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.selectedAgentName || !scope.selectedSessionId) {
    return <TracesTable data={undefined} error={undefined} />
  }

  const result = await listTraceSessionsAction(
    {
      agentName: scope.selectedAgentName,
      sessionID: scope.selectedSessionId,
    },
    {
      limit: params.limit,
      page_token: params.pageToken,
      started_after: params.range.startedAfter,
      started_before: params.range.startedBefore,
    }
  )

  return <TracesTable data={result.data} error={result.error} />
}

function TracesFiltersSkeleton() {
  return <div className="bg-muted/20 h-15 border-b" />
}

type ResolvedTracesSearchParams = {
  agentName?: string
  limit: number
  pageToken?: string
  range: TraceDateRange
  sessionID?: string
}

async function getTraceScopeFromSearchParams(
  agents: Promise<ListAgentActionResponse>,
  searchParams: Promise<ResolvedTracesSearchParams>
) {
  const params = await searchParams

  return getTraceScope({
    agents,
    agentName: params.agentName,
    sessionID: params.sessionID,
  })
}

async function resolveTracesSearchParams(searchParams: Promise<TracesSearchParams>) {
  const params = await searchParams
  const from = firstSearchParam(params.from)
  const to = firstSearchParam(params.to)

  return {
    agentName: firstSearchParam(params.agent_name),
    limit: parseLimitParam(firstSearchParam(params.limit)),
    pageToken: firstSearchParam(params.page_token),
    range: traceDateRange(from, to),
    sessionID: firstSearchParam(params.session_id),
  } satisfies ResolvedTracesSearchParams
}

function ErrorPanel({ message }: { message: string }) {
  return <div className="bg-destructive/5 text-destructive rounded-md p-4 text-sm">{message}</div>
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

  const sessionResult = await listTraceSessionFilterAction(selectedAgentName)
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
