import type { Metadata } from "next"
import { cache, Suspense } from "react"
import * as z from "zod"
import { AdministrationPageHeader } from "@/components/administration"
import { EventsChart } from "@/components/events-chart"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import {
  getTraceChartAction,
  listTraceSessionFilterAction,
  listTraceSessionsAction,
} from "@/data/lens.actions"
import type { ListAgentActionResponse, TraceSessionFilterItem } from "@/data/types"
import { LensFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/lens-filters"
import {
  lensDateRange,
  type LensDateRange,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/search-params"
import { TracesSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/traces/traces-skeleton"
import { TracesTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/traces/traces-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata: Metadata = {
  title: "Traces",
}

const defaultTraceLimit = 25

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
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<TracesSearchParams>
}) {
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind !== "ready") {
    return <ErrorPanel message="Workspace is unavailable" />
  }
  if (!workspace.workspace.capabilities.observability.read) {
    return <ErrorPanel message="You do not have Lens access in this Workspace" />
  }

  const resolved = resolveTracesSearchParams(searchParams)
  const workspaceId = workspace.workspace.id

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="Traces" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <Suspense
          fallback={
            <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
              <Skeleton className="h-8 w-full sm:w-64" />
              <Skeleton className="h-8 w-full sm:w-72" />
              <Skeleton className="h-8 w-full sm:w-72" />
            </div>
          }
        >
          <Filters searchParams={resolved} workspaceId={workspaceId} />
        </Suspense>
        <Suspense fallback={<EventsChartSkeleton />}>
          <Chart searchParams={resolved} workspaceId={workspaceId} />
        </Suspense>
        <Suspense fallback={<TracesSkeleton />}>
          <Traces searchParams={resolved} workspaceId={workspaceId} />
        </Suspense>
      </div>
    </main>
  )
}

async function Filters({
  searchParams,
  workspaceId,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params, workspaceId)
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  return (
    <LensFilters
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
  workspaceId,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params, workspaceId)
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
      started_after: params.range.after,
      started_before: params.range.before,
    },
    workspaceId
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <EventsChart data={result.data} label="Traces" />
}

async function Traces({
  searchParams,
  workspaceId,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const scope = await getTraceScopeForParams(params, workspaceId)
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.selectedAgentName) {
    if (params.agentName && scope.agents.length > 0) {
      return <EmptyState message="The selected agent is no longer accessible" />
    }
    return <EmptyState message="No accessible agents" />
  }
  if (!scope.selectedSessionId) {
    return <EmptyState message="No trace sessions for this agent" />
  }

  const result = await listTraceSessionsAction(
    {
      agentName: scope.selectedAgentName,
      sessionID: scope.selectedSessionId,
    },
    {
      limit: params.limit,
      page_token: params.pageToken,
      started_after: params.range.after,
      started_before: params.range.before,
    },
    workspaceId
  )

  return <TracesTable data={result.data} error={result.error} workspaceId={workspaceId} />
}

type ResolvedTracesSearchParams = {
  agentName?: string
  limit: number
  pageToken?: string
  range: LensDateRange
  sessionID?: string
}

const getTraceScopeForParams = cache(function getTraceScopeForParams(
  params: ResolvedTracesSearchParams,
  workspaceId: string
) {
  return getTraceScope({
    agents: listAgentsCachedQuery(undefined, workspaceId),
    agentName: params.agentName,
    sessionID: params.sessionID,
    workspaceId,
  })
})

async function resolveTracesSearchParams(searchParams: Promise<TracesSearchParams>) {
  const params = tracesSearchParamsSchema.parse(await searchParams)

  return {
    agentName: params.agent_name,
    limit: parseLimitParam(params.limit),
    pageToken: params.page_token,
    range: lensDateRange(params.from, params.to),
    sessionID: params.session_id,
  } satisfies ResolvedTracesSearchParams
}

function parseLimitParam(value?: string) {
  const limit = Number(value)
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : defaultTraceLimit
}

function ErrorPanel({ message }: { message: string }) {
  return <div className="bg-destructive/5 text-destructive rounded-md p-4 text-sm">{message}</div>
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}

async function getTraceScope({
  agents,
  agentName,
  sessionID,
  workspaceId,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  sessionID?: string
  workspaceId: string
}): Promise<TraceScope> {
  const agentResult = await agents
  if (agentResult.error) {
    return traceScopeFailure(agentResult.error)
  }

  const selectedAgentName = agentName
    ? agentResult.agents.find((agent) => agent.name === agentName)?.name
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

  const sessionResult = await listTraceSessionFilterAction(selectedAgentName, workspaceId)
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
