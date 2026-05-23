import { Suspense } from "react"
import Workflow from "@/components/blocks/workflow/workflow"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectWorkflowFiltersAction } from "@/data/workflow.actions"
import { listWorkflowSummariesCachedQuery, getWorkflowCachedQuery } from "@/data/workflow.queries"
import { firstSearchParam } from "@/lib/search-params"
import { WorkflowsFilters } from "./workflows-filters"

type SearchParams = {
  agent_name?: string | string[]
  workflow_name?: string | string[]
}

export const unstable_instant = {
  prefetch: "runtime",
  samples: [
    {
      searchParams: {
        agent_name: "",
        workflow_name: "",
      },
    },
  ],
}

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const agents = listAgentsCachedQuery()

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Workflows</h1>
        </div>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={searchParams} agents={agents} />
      </Suspense>
      <Suspense fallback={<CanvasSkeleton />}>
        <WorkflowContent searchParams={searchParams} agents={agents} />
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
  const selectedAgentName = firstSearchParam(params.agent_name)
  const selectedWorkflowName = firstSearchParam(params.workflow_name)
  const agentsResult = await agents
  if (agentsResult.error || !agentsResult.agents || agentsResult.agents.length === 0) {
    return <FiltersSkeleton />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === selectedAgentName) ?? agentsResult.agents[0]
  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  const workflows = workflowsResult.summaries ?? []
  const selectedWorkflow =
    workflows.find((workflow) => workflow.workflow_name === selectedWorkflowName) ?? workflows[0]

  return (
    <WorkflowsFilters
      key={`${selectedAgent.name}:${selectedWorkflow?.workflow_name ?? ""}`}
      action={selectWorkflowFiltersAction}
      agents={agentsResult.agents}
      selectedAgentName={selectedAgent.name}
      workflows={workflows}
      selectedWorkflowName={selectedWorkflow?.workflow_name}
    />
  )
}

async function WorkflowContent({
  searchParams,
  agents,
}: {
  searchParams: Promise<SearchParams>
  agents: ReturnType<typeof listAgentsCachedQuery>
}) {
  const params = await searchParams
  const selectedAgentName = firstSearchParam(params.agent_name)
  const selectedWorkflowName = firstSearchParam(params.workflow_name)
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents?.find((agent) => agent.name === selectedAgentName) ??
    agentsResult.agents?.[0]
  if (!selectedAgent) {
    return <EmptyState message="No agents available" />
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(selectedAgent.name)
  if (workflowsResult.error) {
    return <ErrorPanel message={workflowsResult.error.message} />
  }

  const selectedWorkflow =
    workflowsResult.summaries?.find(
      (workflow) => workflow.workflow_name === selectedWorkflowName
    ) ?? workflowsResult.summaries?.[0]
  if (!selectedWorkflow) {
    return <EmptyState message={`No workflows available for ${selectedAgent.name}`} />
  }

  const workflowResult = await getWorkflowCachedQuery(
    selectedAgent.name,
    selectedWorkflow.workflow_name
  )
  if (workflowResult.error) {
    return <ErrorPanel message={workflowResult.error.message} />
  }
  if (!workflowResult.workflow) {
    return <ErrorPanel message="Workflow data is unavailable" />
  }

  return (
    <Workflow
      key={`${selectedAgent.name}:${selectedWorkflow.workflow_name}`}
      workflow={workflowResult.workflow}
    />
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

function CanvasSkeleton() {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden border-t bg-sidebar">
      <div className="absolute inset-0 bg-[radial-gradient(circle,theme(colors.sidebar-border)_1px,transparent_1px)] [background-size:10px_10px] opacity-35" />
      <div className="absolute left-4 top-4 z-10 w-sm max-w-sm rounded-md border bg-card p-1">
        <div className="flex items-start gap-2 rounded-sm px-3 py-2">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="mt-0.5 size-4 rounded-sm" />
        </div>
      </div>
      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-px overflow-hidden rounded-md border bg-card p-1">
        <Skeleton className="size-[26px] rounded-sm" />
        <Skeleton className="size-[26px] rounded-sm" />
        <Skeleton className="size-[26px] rounded-sm" />
      </div>
      <div className="absolute left-9 right-10 top-[53%] -translate-y-1/2">
        <div className="flex min-w-max items-center gap-12">
          <WorkflowNodeSkeleton widthClassName="w-36" />
          <WorkflowNodeSkeleton widthClassName="w-36" />
          <WorkflowNodeSkeleton widthClassName="w-40" />
          <WorkflowNodeSkeleton widthClassName="w-36" />
          <WorkflowNodeSkeleton widthClassName="w-36" />
          <WorkflowNodeSkeleton widthClassName="w-36" isLast />
        </div>
      </div>
    </div>
  )
}

function WorkflowNodeSkeleton({
  widthClassName,
  isLast = false,
}: {
  widthClassName: string
  isLast?: boolean
}) {
  return (
    <div className="relative shrink-0">
      {isLast ? null : (
        <div className="absolute left-full top-1/2 ml-2.5 h-px w-9 -translate-y-1/2 bg-sidebar-ring/45" />
      )}
      <div className={`rounded-sm border bg-card/95 p-1.5 shadow-sm ${widthClassName}`}>
        <div className="space-y-1.5">
          <div className="space-y-1.5">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-5/6" />
            <Skeleton className="h-2 w-4/5" />
          </div>
          <div className="space-y-1.5 pt-1">
            <Skeleton className="h-1.5 w-6" />
            <Skeleton className="h-2 w-11/12" />
          </div>
          <div className="space-y-1.5 pt-1">
            <Skeleton className="h-1.5 w-12" />
            <Skeleton className="h-2 w-full" />
          </div>
          <div className="flex gap-1 pt-1">
            <Skeleton className="h-3 w-7 rounded-full" />
            <Skeleton className="h-3 w-6 rounded-full" />
          </div>
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}
