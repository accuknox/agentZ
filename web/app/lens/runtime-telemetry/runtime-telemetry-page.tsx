import { Suspense } from "react"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectedSessionID } from "@/data/agent.utils"
import type { Error } from "@/lib/gateway/client"
import type {
  FileTelemetryActionResponse,
  NetworkTelemetryActionResponse,
  ProcessTelemetryActionResponse,
} from "@/data/types"
import { TelemetryChart } from "@/app/lens/runtime-telemetry/telemetry-chart"
import { TelemetryChartSkeleton } from "@/app/lens/runtime-telemetry/telemetry-chart-skeleton"
import { TelemetryFilters } from "@/app/lens/runtime-telemetry/telemetry-filters"
import {
  firstSearchParam,
  telemetryDateRange,
  type TelemetryDateRange,
} from "@/app/lens/runtime-telemetry/search-params"
import { TelemetryTableSkeleton } from "@/app/lens/runtime-telemetry/telemetry-table-skeleton"
import { TelemetryTabs } from "@/app/lens/runtime-telemetry/telemetry-tabs"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"

type TelemetrySearchParams = {
  session_id?: string | string[]
  from?: string | string[]
  to?: string | string[]
  telemetry_page_token?: string | string[]
}

type TelemetryPageProps = {
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
    session_id: string
    event_time_after: string
    event_time_before: string
    page_token?: string
  }) => Promise<TelemetryPageResponse<TData>>
  renderTable: (data: TData) => React.ReactNode
  value: "process" | "file" | "network"
}

export async function RuntimeTelemetryPage<TData extends TelemetryPageData>({
  config,
  searchParams,
}: TelemetryPageProps & {
  config: TelemetryPageConfig<TData>
}) {
  const search = await searchParams
  const sessionIdFromUrl = firstSearchParam(search.session_id)
  const from = firstSearchParam(search.from)
  const to = firstSearchParam(search.to)
  const pageToken = firstSearchParam(search.telemetry_page_token)
  const range = telemetryDateRange(from, to)

  const agentsResult = await listAgentsCachedQuery(true)
  const agents = agentsResult.agents ?? []
  const sessionID = selectedSessionID(agentsResult, sessionIdFromUrl)

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters agents={agents} selectedSessionID={sessionID} from={range.from} to={range.to} />
      </Suspense>
      <Tabs value={config.value} className="flex flex-1 flex-col">
        <div className="border-b px-6">
          <TabsList variant="line" className="h-10 gap-4">
            <TelemetryTabs />
          </TabsList>
        </div>
        <div className="flex flex-1 flex-col">
          <TabsContent value={config.value} className="m-0 flex flex-1 flex-col">
            {!sessionID ? (
              <EmptyState message="No agents available" />
            ) : (
              <TelemetryContent
                config={config}
                pageToken={pageToken}
                range={range}
                sessionID={sessionID}
              />
            )}
          </TabsContent>
        </div>
      </Tabs>
    </main>
  )
}

function PageHeader() {
  return (
    <div className="flex items-center justify-between px-6">
      <div className="min-w-0">
        <h1 className="text-base font-medium tracking-normal">Runtime Telemetry</h1>
      </div>
    </div>
  )
}

async function TelemetryContent<TData extends TelemetryPageData>({
  config,
  pageToken,
  range,
  sessionID,
}: {
  config: TelemetryPageConfig<TData>
  pageToken?: string
  range: TelemetryDateRange
  sessionID: string
}) {
  return (
    <>
      <Suspense
        key={`chart-${config.value}-${sessionID}-${range.eventTimeAfter}-${range.eventTimeBefore}`}
        fallback={<TelemetryChartSkeleton />}
      >
        <Chart config={config} sessionID={sessionID} range={range} />
      </Suspense>
      <Suspense
        key={`table-${config.value}-${sessionID}-${range.eventTimeAfter}-${range.eventTimeBefore}-${pageToken ?? ""}`}
        fallback={<TelemetryTableSkeleton headers={config.headers} />}
      >
        <Table config={config} sessionID={sessionID} range={range} pageToken={pageToken} />
      </Suspense>
    </>
  )
}

async function Chart<TData extends TelemetryPageData>({
  config,
  sessionID,
  range,
}: {
  config: TelemetryPageConfig<TData>
  sessionID: string
  range: TelemetryDateRange
}) {
  const result = await config.loadAction({
    session_id: sessionID,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TelemetryChart data={result.data.chart} />
}

async function Table<TData extends TelemetryPageData>({
  config,
  sessionID,
  range,
  pageToken,
}: {
  config: TelemetryPageConfig<TData>
  sessionID: string
  range: TelemetryDateRange
  pageToken?: string
}) {
  const result = await config.loadAction({
    session_id: sessionID,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
    page_token: pageToken,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return config.renderTable(result.data)
}

function Filters({
  agents,
  selectedSessionID,
  from,
  to,
}: {
  agents: Awaited<ReturnType<typeof listAgentsCachedQuery>>["agents"]
  selectedSessionID?: string
  from?: string
  to?: string
}) {
  if (!agents || agents.length === 0) {
    return null
  }

  return (
    <TelemetryFilters agents={agents} selectedSessionID={selectedSessionID} from={from} to={to} />
  )
}

function FiltersSkeleton() {
  return <div className="h-15 border-b bg-muted/20" />
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="m-6 rounded-md bg-destructive/5 p-4 text-sm text-destructive">{message}</div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}
