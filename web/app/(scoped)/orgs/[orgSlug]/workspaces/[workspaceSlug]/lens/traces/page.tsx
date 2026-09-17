import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { EventsChart } from "@/components/events-chart"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import { getTraceChartAction, listTraceSessionsAction } from "@/data/lens.actions"
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
  const scope = resolved.then((params) =>
    resolvePageSelection(workspace, "lens/traces", {
      agent_name: params.agentName,
      session_id: params.sessionID,
    })
  )

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
          <Filters searchParams={resolved} scope={scope} />
        </Suspense>
        <Suspense fallback={<EventsChartSkeleton />}>
          <Chart searchParams={resolved} workspaceId={workspaceId} scope={scope} />
        </Suspense>
        <Suspense fallback={<TracesSkeleton />}>
          <Traces searchParams={resolved} workspaceId={workspaceId} scope={scope} />
        </Suspense>
      </div>
    </main>
  )
}

async function Filters({
  searchParams,
  scope: scopePromise,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  scope: Promise<ResolvedPageSelection>
}) {
  const params = await searchParams
  const scope = await scopePromise
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  return (
    <>
      <RememberPageSelection selected={scope.selected} requested={scope.requested} />
      <LensFilters
        agents={scope.agents}
        sessions={scope.sessions}
        selectedAgentName={scope.selected.agent_name}
        selectedSessionId={scope.selected.session_id}
        from={params.range.from}
        to={params.range.to}
      />
    </>
  )
}

async function Chart({
  searchParams,
  workspaceId,
  scope: scopePromise,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  workspaceId: string
  scope: Promise<ResolvedPageSelection>
}) {
  const params = await searchParams
  const scope = await scopePromise
  if (scope.error) {
    return null
  }

  if (!scope.selected.agent_name) {
    return null
  }
  const sessionID = scope.selected.session_id
  if (!sessionID) {
    return null
  }

  const result = await getTraceChartAction(
    {
      agentName: scope.selected.agent_name,
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
  scope: scopePromise,
}: {
  searchParams: Promise<ResolvedTracesSearchParams>
  workspaceId: string
  scope: Promise<ResolvedPageSelection>
}) {
  const params = await searchParams
  const scope = await scopePromise
  if (scope.error) {
    return <ErrorPanel message={scope.error.message} />
  }

  if (!scope.selected.agent_name) {
    return <EmptyState message="No accessible agents" />
  }
  if (!scope.selected.session_id) {
    return <EmptyState message="No trace sessions for this agent" />
  }

  const result = await listTraceSessionsAction(
    {
      agentName: scope.selected.agent_name,
      sessionID: scope.selected.session_id,
    },
    {
      limit: params.limit,
      page_token:
        scope.selected.agent_name === scope.requested.agent_name &&
        scope.selected.session_id === scope.requested.session_id
          ? params.pageToken
          : undefined,
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
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
