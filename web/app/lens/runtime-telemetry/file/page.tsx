import { Suspense } from "react"
import { getFileTelemetryAction } from "@/data/lens.actions"
import { listAgentsAction } from "@/data/agent.actions"
import type { ListAgentActionResponse } from "@/data/types"
import { TelemetryChart } from "@/app/lens/runtime-telemetry/telemetry-chart"
import { TelemetryChartSkeleton } from "@/app/lens/runtime-telemetry/telemetry-chart-skeleton"
import { TelemetryFilters } from "@/app/lens/runtime-telemetry/telemetry-filters"
import { TelemetryTabs } from "@/app/lens/runtime-telemetry/telemetry-tabs"
import { TelemetryTableSkeleton } from "@/app/lens/runtime-telemetry/telemetry-table-skeleton"
import { FileTelemetryTable } from "@/app/lens/runtime-telemetry/file-telemetry-table"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"
import {
  firstSearchParam,
  telemetryDateRange,
  type TelemetryDateRange,
} from "@/app/lens/runtime-telemetry/search-params"

type Props = {
  searchParams: Promise<{
    session_id?: string | string[]
    from?: string | string[]
    to?: string | string[]
  }>
}

export default async function FilePage({ searchParams }: Props) {
  const search = await searchParams
  const sessionIdFromUrl = firstSearchParam(search.session_id)
  const from = firstSearchParam(search.from)
  const to = firstSearchParam(search.to)
  const range = telemetryDateRange(from, to)

  const agentsResult = await listAgentsAction(true)
  const agents = agentsResult.agents ?? []
  const sessionID = getSelectedSessionID(agentsResult, sessionIdFromUrl)

  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <PageHeader />
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters agents={agents} selectedSessionID={sessionID} from={range.from} to={range.to} />
      </Suspense>
      <Tabs value="file" className="flex flex-1 flex-col">
        <div className="border-b px-6">
          <TabsList variant="line" className="h-10 gap-4">
            <TelemetryTabs />
          </TabsList>
        </div>
        <div className="flex flex-1 flex-col">
          <TabsContent value="file" className="m-0 flex flex-1 flex-col">
            {!sessionID ? (
              <EmptyState message="No agents available" />
            ) : (
              <FileContent sessionID={sessionID} range={range} />
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

function Filters({
  agents,
  selectedSessionID,
  from,
  to,
}: {
  agents: ListAgentActionResponse["agents"]
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

async function FileContent({ sessionID, range }: { sessionID: string; range: TelemetryDateRange }) {
  return (
    <>
      <Suspense
        key={`chart-${sessionID}-${range.eventTimeAfter}-${range.eventTimeBefore}`}
        fallback={<TelemetryChartSkeleton />}
      >
        <Chart sessionID={sessionID} range={range} />
      </Suspense>
      <Suspense
        key={`table-${sessionID}-${range.eventTimeAfter}-${range.eventTimeBefore}`}
        fallback={
          <TelemetryTableSkeleton
            headers={["File Path Accessed", "Process", "Action", "Occurrences", "Last Seen"]}
          />
        }
      >
        <Table sessionID={sessionID} range={range} />
      </Suspense>
    </>
  )
}

async function Chart({ sessionID, range }: { sessionID: string; range: TelemetryDateRange }) {
  const result = await getFileTelemetryAction({
    session_id: sessionID,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <TelemetryChart data={result.data.chart} />
}

async function Table({ sessionID, range }: { sessionID: string; range: TelemetryDateRange }) {
  const result = await getFileTelemetryAction({
    session_id: sessionID,
    event_time_after: range.eventTimeAfter,
    event_time_before: range.eventTimeBefore,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return <FileTelemetryTable data={result.data.rows} />
}

function getSelectedSessionID(result: ListAgentActionResponse, sessionIdFromUrl?: string) {
  if (result.error) {
    return undefined
  }
  return sessionIdFromUrl ?? result.agents[0]?.session_id
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
