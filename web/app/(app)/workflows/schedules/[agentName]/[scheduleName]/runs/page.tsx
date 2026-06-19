import type { Metadata } from "next"
import { Suspense } from "react"
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

export async function generateMetadata({
  params,
}: {
  params: Promise<RunsParams>
}): Promise<Metadata> {
  const { scheduleName } = await params

  return {
    title: `Workflow Runs: ${scheduleName}`,
  }
}

export default function ScheduledWorkflowRunsPage({
  params,
  searchParams,
}: {
  params: Promise<RunsParams>
  searchParams: Promise<RunsSearchParams>
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Scheduled Workflow Runs</h1>
        </div>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters params={params} />
      </Suspense>
      <Suspense fallback={<RunsTableSkeleton />}>
        <Runs params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function Filters({ params }: { params: Promise<RunsParams> }) {
  const agents = listAgentsCachedQuery()
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
      key={`${agentName}:${scheduleName}`}
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
  const schedulesResult = await listWorkflowSchedulesCachedQuery(agentName, { limit: 200 })
  if (schedulesResult.error || !schedulesResult.workflowSchedules) {
    return <ErrorPanel message={schedulesResult.error?.message ?? "Unable to load schedules"} />
  }

  const schedule = schedulesResult.workflowSchedules.find((item) => item.name === scheduleName)
  if (!schedule) {
    return <ErrorPanel message="Workflow schedule not found" />
  }

  const result = await listWorkflowRunsCachedQuery(
    agentName,
    schedule.workflow_name,
    scheduleName,
    {
      limit: 25,
      page_token: pageToken,
    }
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <RunsTable
      agentName={agentName}
      workflowName={schedule.workflow_name}
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
    <div className="bg-background border-b px-6 py-2">
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
    <div className="bg-destructive/5 text-destructive m-6 rounded-md p-4 text-sm">{message}</div>
  )
}
