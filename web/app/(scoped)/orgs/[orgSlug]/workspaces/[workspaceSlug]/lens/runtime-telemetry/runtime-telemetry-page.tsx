import { RememberRoute } from "@/data/route-memory"
import { RequestError } from "@/components/request-error"
import { Suspense } from "react"
import RuntimeTelemetryLoading from "./loading"
import { EventsChart } from "@/components/events-chart"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import * as z from "zod"
import { resolvePageSelection, type ResolvedPageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import type { Error } from "@/lib/gateway/client"
import type {
  FileTelemetryActionResponse,
  NetworkTelemetryActionResponse,
  ProcessTelemetryActionResponse,
} from "@/data/types"
import { LensFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/lens-filters"
import {
  lensDateRange,
  type LensDateRange,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/search-params"
import { TelemetryTableSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table-skeleton"
import { searchParamStringSchema } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"

const telemetrySearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  from: searchParamStringSchema,
  to: searchParamStringSchema,
  telemetry_page_token: searchParamStringSchema,
})

type TelemetryPageProps =
  PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry">

type TelemetryPageData =
  | NonNullable<ProcessTelemetryActionResponse["data"]>
  | NonNullable<FileTelemetryActionResponse["data"]>
  | NonNullable<NetworkTelemetryActionResponse["data"]>

type TelemetryPageResponse<TData extends TelemetryPageData> =
  | { data: TData; error: undefined }
  | { data: undefined; error: Error }

export type TelemetryPageConfig<TData extends TelemetryPageData> = {
  headers: string[]
  loadAction: (args: {
    agent_name: string
    event_time_after: string
    event_time_before: string
    page_token?: string
    workspace_id: string
  }) => Promise<TelemetryPageResponse<TData>>
  renderTable: (data: TData) => React.ReactNode
  value: "process" | "file" | "network"
}

export function RuntimeTelemetryPage<TData extends TelemetryPageData>(
  props: TelemetryPageProps & {
    config: TelemetryPageConfig<TData>
  }
) {
  return (
    <Suspense fallback={<RuntimeTelemetryLoading />}>
      <WorkspaceTelemetry {...props} />
    </Suspense>
  )
}

async function WorkspaceTelemetry<TData extends TelemetryPageData>({
  config,
  params,
  searchParams,
}: TelemetryPageProps & {
  config: TelemetryPageConfig<TData>
}) {
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (workspace.kind === "error")
    return <RequestError title="Could not load this workspace" error={workspace.error} />
  if (workspace.kind !== "ready") {
    return (
      <RequestError
        title="Could not load runtime telemetry"
        description="Workspace is unavailable"
      />
    )
  }
  if (!workspace.workspace.capabilities.observability.read) {
    return (
      <RequestError
        title="Could not load runtime telemetry"
        description="You do not have Lens access in this Workspace"
      />
    )
  }

  const search = telemetrySearchParamsSchema.parse(await searchParams)
  const resolved = { ...search, range: lensDateRange(search.from, search.to) }
  const selection = resolvePageSelection(
    workspace,
    config.value === "process"
      ? "lens/runtime-telemetry"
      : `lens/runtime-telemetry/${config.value}`,
    search
  )
  const workspaceId = workspace.workspace.id

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
            <Skeleton className="h-8 w-full sm:w-64" />
            <Skeleton className="h-8 w-full sm:w-72" />
          </div>
        }
      >
        <Filters searchParams={resolved} selection={selection} />
      </Suspense>
      <Suspense fallback={<TelemetryTableSkeleton headers={config.headers} />}>
        <TelemetryContent
          config={config}
          searchParams={resolved}
          selection={selection}
          workspaceId={workspaceId}
        />
      </Suspense>
    </div>
  )
}

async function TelemetryContent<TData extends TelemetryPageData>({
  config,
  searchParams: params,
  workspaceId,
  selection,
}: {
  config: TelemetryPageConfig<TData>
  searchParams: ResolvedTelemetrySearchParams
  workspaceId: string
  selection: Promise<ResolvedPageSelection>
}) {
  const { selected, requested, error } = await selection
  const agentName = selected.agent_name
  const range = params.range
  const pageToken =
    selected.agent_name === requested.agent_name ? params.telemetry_page_token : undefined
  if (error) {
    return <RequestError title="Could not load runtime telemetry" error={error} />
  }
  if (range.error)
    return <RequestError resetFilters title="That date range is out of reach" error={range.error} />

  if (!agentName) {
    return <EmptyState message="No agents available" />
  }

  return (
    <>
      <Suspense
        key={`chart-${config.value}-${agentName}-${range.from}-${range.to}`}
        fallback={<EventsChartSkeleton />}
      >
        <Chart config={config} agentName={agentName} range={range} workspaceId={workspaceId} />
      </Suspense>
      <Suspense
        key={`table-${config.value}-${agentName}-${range.from}-${range.to}-${pageToken ?? ""}`}
        fallback={<TelemetryTableSkeleton headers={config.headers} />}
      >
        <Table
          config={config}
          agentName={agentName}
          range={range}
          pageToken={pageToken}
          workspaceId={workspaceId}
        />
      </Suspense>
    </>
  )
}

async function Chart<TData extends TelemetryPageData>({
  config,
  agentName,
  range,
  workspaceId,
}: {
  config: TelemetryPageConfig<TData>
  agentName: string
  range: LensDateRange
  workspaceId: string
}) {
  const result = await config.loadAction({
    agent_name: agentName,
    event_time_after: range.from,
    event_time_before: range.to,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <RequestError title="Could not load runtime telemetry" error={result.error} />
  }

  return <EventsChart data={result.data.chart} />
}

async function Table<TData extends TelemetryPageData>({
  config,
  agentName,
  range,
  pageToken,
  workspaceId,
}: {
  config: TelemetryPageConfig<TData>
  agentName: string
  range: LensDateRange
  pageToken?: string
  workspaceId: string
}) {
  const result = await config.loadAction({
    agent_name: agentName,
    event_time_after: range.from,
    event_time_before: range.to,
    page_token: pageToken,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <RequestError title="Could not load runtime telemetry" error={result.error} />
  }

  return config.renderTable(result.data)
}

async function Filters({
  searchParams: params,
  selection,
}: {
  searchParams: ResolvedTelemetrySearchParams
  selection: Promise<ResolvedPageSelection>
}) {
  const state = await selection
  return (
    <>
      {!state.error ? <RememberRoute /> : null}
      <RememberPageSelection {...state} />
      <LensFilters
        workspaceId={state.workspaceId}
        agents={state.agents}
        selectedAgentName={state.selected.agent_name}
        from={params.range.from}
        to={params.range.to}
      />
    </>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}

type ResolvedTelemetrySearchParams = z.output<typeof telemetrySearchParamsSchema> & {
  range: LensDateRange
}
