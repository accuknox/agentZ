import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
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
  parseLimitParam,
  type TraceDateRange,
  traceDateRange,
} from "@/app/(app)/lens/traces/search-params"
import { TracesSkeleton } from "@/app/(app)/lens/traces/traces-skeleton"
import { TracesTable } from "@/app/(app)/lens/traces/traces-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Traces",
}

const tracesSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  session_id: searchParamStringSchema,
  from: searchParamStringSchema,
  to: searchParamStringSchema,
  page_token: searchParamStringSchema,
  limit: searchParamStringSchema,
})

type TracesSearchParams = {
  agent_name?: SearchParamStringInput
  session_id?: SearchParamStringInput
  from?: SearchParamStringInput
  to?: SearchParamStringInput
  page_token?: SearchParamStringInput
  limit?: SearchParamStringInput
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
  const params = resolveTracesSearchParams(searchParams)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<TracesFiltersSkeleton />}>
        <Filters searchParams={params} />
      </Suspense>
      <Suspense fallback={<TracesChartSkeleton />}>
        <Chart searchParams={params} />
      </Suspense>
      <Suspense fallback={<TracesSkeleton />}>
        <Traces searchParams={params} />
      </Suspense>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex min-w-0 items-center justify-between px-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">Traces</h1>
      </div>
    </div>
  )
}

async function Filters({ searchParams }: { searchParams: Promise<ResolvedTracesSearchParams> }) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params)
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

async function Chart({ searchParams }: { searchParams: Promise<ResolvedTracesSearchParams> }) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params)
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

async function Traces({ searchParams }: { searchParams: Promise<ResolvedTracesSearchParams> }) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params)
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

async function getTraceScopeForParams(params: ResolvedTracesSearchParams) {
  return getTraceScope({
    agents: listAgentsCachedQuery(),
    agentName: params.agentName,
    sessionID: params.sessionID,
  })
}

async function resolveTracesSearchParams(searchParams: Promise<TracesSearchParams>) {
  const params = tracesSearchParamsSchema.parse(await searchParams)

  return {
    agentName: params.agent_name,
    limit: parseLimitParam(params.limit),
    pageToken: params.page_token,
    range: traceDateRange(params.from, params.to),
    sessionID: params.session_id,
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
