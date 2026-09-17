import { Suspense } from "react"
import RuntimeTelemetryLoading from "./loading"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { TelemetryTabs } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-tabs"
import { Tabs, TabsContent } from "@/components/ui/tabs"
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
  if (workspace.kind !== "ready") {
    return <ErrorPanel message="Workspace is unavailable" />
  }
  if (!workspace.workspace.capabilities.observability.read) {
    return <ErrorPanel message="You do not have Lens access in this Workspace" />
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
  const basePath = `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}/lens/runtime-telemetry`
  const workspaceId = workspace.workspace.id

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="Runtime Telemetry" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
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
        <Tabs value={config.value} className="flex flex-1 flex-col">
          <div className="border-b px-4 py-2 sm:px-6">
            <TelemetryTabs basePath={basePath} />
          </div>
          <div className="flex flex-1 flex-col">
            <TabsContent value={config.value} className="m-0 flex flex-1 flex-col">
              <Suspense fallback={<TelemetryTableSkeleton headers={config.headers} />}>
                <TelemetryContent
                  config={config}
                  searchParams={resolved}
                  selection={selection}
                  workspaceId={workspaceId}
                />
              </Suspense>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </main>
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
    return <ErrorPanel message={error.message} />
  }

  if (!agentName) {
    return <EmptyState message="No agents available" />
  }

  return (
    <>
      <Suspense
        key={`chart-${config.value}-${agentName}-${range.after}-${range.before}`}
        fallback={<EventsChartSkeleton />}
      >
        <Chart config={config} agentName={agentName} range={range} workspaceId={workspaceId} />
      </Suspense>
      <Suspense
        key={`table-${config.value}-${agentName}-${range.after}-${range.before}-${pageToken ?? ""}`}
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
    event_time_after: range.after,
    event_time_before: range.before,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
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
    event_time_after: range.after,
    event_time_before: range.before,
    page_token: pageToken,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
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
  if (state.error) return <ErrorPanel message={state.error.message} />
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <LensFilters
        agents={state.agents}
        selectedAgentName={state.selected.agent_name}
        from={params.range.from}
        to={params.range.to}
      />
    </>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert className="px-6" variant="destructive">
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

type ResolvedTelemetrySearchParams = z.output<typeof telemetrySearchParamsSchema> & {
  range: LensDateRange
}
