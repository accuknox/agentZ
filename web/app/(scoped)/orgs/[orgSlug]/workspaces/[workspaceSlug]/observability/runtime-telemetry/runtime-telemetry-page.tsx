import { Suspense } from "react"
import * as z from "zod"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import type { Error } from "@/lib/gateway/client"
import type {
  FileTelemetryActionResponse,
  NetworkTelemetryActionResponse,
  ProcessTelemetryActionResponse,
} from "@/data/types"
import { TelemetryChart } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-chart"
import { TelemetryChartSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-chart-skeleton"
import { TelemetryFilters } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-filters"
import {
  telemetryDateRange,
  type TelemetryDateRange,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/search-params"
import { TelemetryTableSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-table-skeleton"
import { TelemetryTabs } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-tabs"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"

const telemetrySearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  from: searchParamStringSchema,
  to: searchParamStringSchema,
  telemetry_page_token: searchParamStringSchema,
})

export type TelemetrySearchParams = {
  agent_name?: SearchParamStringInput
  from?: SearchParamStringInput
  to?: SearchParamStringInput
  telemetry_page_token?: SearchParamStringInput
}

type TelemetryPageProps = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<TelemetrySearchParams>
}

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

export async function RuntimeTelemetryPage<TData extends TelemetryPageData>({
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
  if (!workspace.workspace.observability_capabilities.read) {
    return <ErrorPanel message="You do not have Observability access in this Workspace" />
  }

  const resolved = resolveTelemetrySearchParams(searchParams)
  const basePath = `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}/observability/runtime-telemetry`
  const workspaceId = workspace.workspace.id

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={resolved} workspaceId={workspaceId} />
      </Suspense>
      <Tabs value={config.value} className="flex flex-1 flex-col">
        <div className="border-b px-4 sm:px-6">
          <TelemetryTabs basePath={basePath} />
        </div>
        <div className="flex flex-1 flex-col">
          <TabsContent value={config.value} className="m-0 flex flex-1 flex-col">
            <Suspense fallback={<TelemetryTableSkeleton headers={config.headers} />}>
              <TelemetryContent config={config} searchParams={resolved} workspaceId={workspaceId} />
            </Suspense>
          </TabsContent>
        </div>
      </Tabs>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex min-w-0 items-center justify-between px-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">Runtime Telemetry</h1>
      </div>
    </div>
  )
}

async function TelemetryContent<TData extends TelemetryPageData>({
  config,
  searchParams,
  workspaceId,
}: {
  config: TelemetryPageConfig<TData>
  searchParams: Promise<ResolvedTelemetrySearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const { agentName, agents, error, pageToken, range } = await resolveTelemetryPageState(
    params,
    workspaceId
  )
  if (error) {
    return <ErrorPanel message={error.message} />
  }

  if (!agentName) {
    if (params.agent_name && agents.length > 0) {
      return <EmptyState message="The selected agent is no longer accessible" />
    }
    return <EmptyState message="No agents available" />
  }

  return (
    <>
      <Suspense
        key={`chart-${config.value}-${agentName}-${range.eventTimeAfter}-${range.eventTimeBefore}`}
        fallback={<TelemetryChartSkeleton />}
      >
        <Chart config={config} agentName={agentName} range={range} workspaceId={workspaceId} />
      </Suspense>
      <Suspense
        key={`table-${config.value}-${agentName}-${range.eventTimeAfter}-${range.eventTimeBefore}-${pageToken ?? ""}`}
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
  range: TelemetryDateRange
  workspaceId: string
}) {
  const result = await config.loadAction({
    agent_name: agentName,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TelemetryChart data={result.data.chart} />
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
  range: TelemetryDateRange
  pageToken?: string
  workspaceId: string
}) {
  const result = await config.loadAction({
    agent_name: agentName,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
    page_token: pageToken,
    workspace_id: workspaceId,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return config.renderTable(result.data)
}

async function Filters({
  searchParams,
  workspaceId,
}: {
  searchParams: Promise<ResolvedTelemetrySearchParams>
  workspaceId: string
}) {
  const params = await searchParams
  const { agents, error, selectedAgentName, range } = await resolveTelemetryPageState(
    params,
    workspaceId
  )
  if (error) {
    return <ErrorPanel message={error.message} />
  }

  return (
    <TelemetryFilters
      agents={agents}
      selectedAgentName={selectedAgentName}
      from={range.from}
      to={range.to}
    />
  )
}

function FiltersSkeleton() {
  return <div className="bg-muted/20 h-15 border-b" />
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

type TelemetryPageState = {
  agentName?: string
  agents: NonNullable<Awaited<ReturnType<typeof listAgentsCachedQuery>>["agents"]>
  error?: Error
  pageToken?: string
  range: TelemetryDateRange
  selectedAgentName?: string
}

type ResolvedTelemetrySearchParams = z.output<typeof telemetrySearchParamsSchema> & {
  range: TelemetryDateRange
}

async function resolveTelemetrySearchParams(
  searchParams: Promise<TelemetrySearchParams>
): Promise<ResolvedTelemetrySearchParams> {
  const search = telemetrySearchParamsSchema.parse(await searchParams)
  const range = telemetryDateRange(search.from, search.to)

  return {
    ...search,
    range,
  }
}

async function resolveTelemetryPageState(
  search: ResolvedTelemetrySearchParams,
  workspaceId: string
) {
  const agentsResult = await listAgentsCachedQuery(undefined, workspaceId)
  if (agentsResult.error) {
    return {
      agents: [],
      error: agentsResult.error,
      pageToken: search.telemetry_page_token,
      range: search.range,
    } satisfies TelemetryPageState
  }

  const agents = agentsResult.agents
  const selectedAgent = search.agent_name
    ? agents.find((agent) => agent.name === search.agent_name)
    : agents[0]

  return {
    agentName: selectedAgent?.name,
    agents,
    error: undefined,
    pageToken: search.telemetry_page_token,
    range: search.range,
    selectedAgentName: selectedAgent?.name,
  } satisfies TelemetryPageState
}
