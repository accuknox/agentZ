import { Suspense } from "react"
import { connection } from "next/server"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectWorkflowRunsFiltersAction } from "@/data/workflow.actions"
import { deleteWorkflowRunAction } from "@/data/workflow-run.actions"
import { listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { listWorkflowSchedulesCachedQuery } from "@/data/workflow-schedule.queries"
import { firstSearchParam } from "@/lib/search-params"
import { RunsFilters } from "./runs-filters"
import { RunsTable } from "./runs-table"

type RunsSearchParams = {
  page_token?: string | string[]
}

type RunsParams = {
  agentName: string
  scheduleName: string
}

export default function ScheduledWorkflowRunsPage({
  params,
  searchParams,
}: {
  params: Promise<RunsParams>
  searchParams: Promise<RunsSearchParams>
}) {
  const agents = listAgentsCachedQuery()

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Scheduled Workflow Runs</h1>
        </div>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters agents={agents} params={params} />
      </Suspense>
      <Suspense fallback={<RunsTableSkeleton />}>
        <Runs params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function Filters({
  agents,
  params,
}: {
  agents: ReturnType<typeof listAgentsCachedQuery>
  params: Promise<RunsParams>
}) {
  const [{ agentName, scheduleName }, agentsResult] = await Promise.all([params, agents])
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    return <FiltersSkeleton />
  }

  const schedulesResult = await listWorkflowSchedulesCachedQuery(agentName, {
    limit: 200,
  })
  if (schedulesResult.error || !schedulesResult.workflowSchedules) {
    return <FiltersSkeleton />
  }

  return (
    <RunsFilters
      agents={agentsResult.agents}
      selectedAgentName={agentName}
      schedules={schedulesResult.workflowSchedules}
      selectedScheduleName={scheduleName}
      action={selectWorkflowRunsFiltersAction}
    />
  )
}

async function Runs({
  params,
  searchParams,
}: {
  params: Promise<RunsParams>
  searchParams: Promise<RunsSearchParams>
}) {
  const [{ agentName, scheduleName }, search] = await Promise.all([params, searchParams])
  const pageToken = firstSearchParam(search.page_token)

  await connection()
  const result = await listWorkflowRunsCachedQuery(agentName, scheduleName, {
    limit: 25,
    page_token: pageToken,
  })
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <RunsTable
      agentName={agentName}
      scheduleName={scheduleName}
      workflowRuns={result.workflowRuns}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteWorkflowRunAction={deleteWorkflowRunAction}
    />
  )
}

function RunsTableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:px-6">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  )
}

function FiltersSkeleton() {
  return (
    <div className="border-b bg-background px-6 py-2">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-52 rounded-md sm:w-64" />
          <Skeleton className="h-8 w-full min-w-52 rounded-md sm:w-72" />
        </div>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="m-6 rounded-md bg-destructive/5 p-4 text-sm text-destructive">{message}</div>
  )
}
