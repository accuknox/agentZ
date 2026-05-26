import { Suspense } from "react"
import { connection } from "next/server"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectWorkflowSchedulesAgentAction } from "@/data/workflow.actions"
import {
  createWorkflowScheduleFormAction,
  deleteWorkflowScheduleFormAction,
  getWorkflowInputSchemaAction,
  updateWorkflowScheduleFormAction,
} from "@/data/workflow-schedule.actions"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { firstSearchParam } from "@/lib/search-params"
import { NewScheduleButton } from "./new-schedule-button"
import { SchedulesFilters } from "./schedules-filters"
import { SchedulesTable } from "./schedules-table"

type SearchParams = {
  agent_name?: string | string[]
  page_token?: string | string[]
}

export const unstable_instant = {
  prefetch: "runtime",
  samples: [
    {
      searchParams: {
        agent_name: "",
        page_token: "",
      },
    },
  ],
}

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const agents = listAgentsCachedQuery()

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Schedules</h1>
        </div>
        <Suspense fallback={<HeaderButtonSkeleton />}>
          <HeaderAction searchParams={searchParams} agents={agents} />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={searchParams} agents={agents} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Schedules searchParams={searchParams} agents={agents} />
      </Suspense>
    </main>
  )
}

async function Filters({
  searchParams,
  agents,
}: {
  searchParams: Promise<SearchParams>
  agents: ReturnType<typeof listAgentsCachedQuery>
}) {
  const params = await searchParams
  const agentsResult = await agents
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    return <FiltersSkeleton />
  }

  return (
    <SchedulesFilters
      agents={agentsResult.agents}
      selectedAgentName={resolveAgentName(agentsResult.agents, params.agent_name)}
      action={selectWorkflowSchedulesAgentAction}
    />
  )
}

async function Schedules({
  searchParams,
  agents,
}: {
  searchParams: Promise<SearchParams>
  agents: ReturnType<typeof listAgentsCachedQuery>
}) {
  const params = await searchParams
  const pageToken = firstSearchParam(params.page_token)
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgentName = resolveAgentName(agentsResult.agents, params.agent_name)
  const selectedAgent = agentsResult.agents?.find((agent) => agent.name === selectedAgentName)
  if (!selectedAgent) {
    return <EmptyState message="No agents available" />
  }

  await connection()
  const schedulesResult = await listWorkflowSchedulesCachedQuery(selectedAgent.name, {
    limit: 50,
    page_token: pageToken,
  })
  if (schedulesResult.error) {
    return <ErrorPanel message={schedulesResult.error.message} />
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  const workflows = workflowsResult.error ? [] : (workflowsResult.summaries ?? [])

  return (
    <SchedulesTable
      agentName={selectedAgent.name}
      workflows={workflows}
      workflowSchedules={schedulesResult.workflowSchedules}
      hasNextPage={schedulesResult.hasNextPage}
      nextPageToken={schedulesResult.nextPageToken}
      deleteWorkflowScheduleAction={deleteWorkflowScheduleFormAction}
      getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
      updateWorkflowScheduleAction={updateWorkflowScheduleFormAction}
    />
  )
}

async function HeaderAction({
  searchParams,
  agents,
}: {
  searchParams: Promise<SearchParams>
  agents: ReturnType<typeof listAgentsCachedQuery>
}) {
  const params = await searchParams
  const agentsResult = await agents
  if (agentsResult.error) {
    return null
  }

  const selectedAgentName = resolveAgentName(agentsResult.agents, params.agent_name)
  const selectedAgent = agentsResult.agents?.find((agent) => agent.name === selectedAgentName)
  if (!selectedAgent) {
    return null
  }

  await connection()
  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  if (workflowsResult.error || !workflowsResult.summaries) {
    return (
      <NewScheduleButton
        agentName={selectedAgent.name}
        workflows={[]}
        createWorkflowScheduleAction={createWorkflowScheduleFormAction}
        getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
      />
    )
  }

  return (
    <NewScheduleButton
      agentName={selectedAgent.name}
      workflows={workflowsResult.summaries}
      createWorkflowScheduleAction={createWorkflowScheduleFormAction}
      getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
    />
  )
}

function FiltersSkeleton() {
  return (
    <div className="border-b bg-background px-6 py-2">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-52 rounded-md sm:w-64" />
        </div>
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}

function HeaderButtonSkeleton() {
  return <Skeleton className="h-9 w-32 rounded-md" />
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

function resolveAgentName(
  agents: Awaited<ReturnType<typeof listAgentsCachedQuery>>["agents"],
  param?: string | string[]
) {
  if (!agents || agents.length === 0) {
    return undefined
  }

  const agentName = firstSearchParam(param)
  return agents.find((agent) => agent.name === agentName)?.name ?? agents[0].name
}
