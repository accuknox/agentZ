import type { Metadata } from "next"
import { Suspense } from "react"
import Workflow from "@/components/blocks/workflow/workflow"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectWorkflowFiltersAction } from "@/data/workflow.actions"
import { listWorkflowSummariesCachedQuery, getWorkflowCachedQuery } from "@/data/workflow.queries"
import { WorkflowsFilters } from "./workflows-filters"

export const metadata: Metadata = {
  title: "Workflow Graphs",
}

type SearchParams = {
  agent_name?: string | string[]
  workflow_name?: string | string[]
}

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Workflows</h1>
        </div>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={params} />
      </Suspense>
      <Suspense fallback={<CanvasSkeleton />}>
        <WorkflowContent searchParams={params} />
      </Suspense>
    </main>
  )
}

async function Filters({ searchParams }: { searchParams: SearchParams }) {
  const agents = listAgentsCachedQuery()
  const selectedAgentName = Array.isArray(searchParams.agent_name)
    ? searchParams.agent_name[0]
    : searchParams.agent_name
  const selectedWorkflowName = Array.isArray(searchParams.workflow_name)
    ? searchParams.workflow_name[0]
    : searchParams.workflow_name
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

async function WorkflowContent({ searchParams }: { searchParams: SearchParams }) {
  const agents = listAgentsCachedQuery()
  const selectedAgentName = Array.isArray(searchParams.agent_name)
    ? searchParams.agent_name[0]
    : searchParams.agent_name
  const selectedWorkflowName = Array.isArray(searchParams.workflow_name)
    ? searchParams.workflow_name[0]
    : searchParams.workflow_name
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

function CanvasSkeleton() {
  return (
    <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-t">
      <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[10px_10px] opacity-35" />
      <div className="bg-card absolute top-4 left-4 z-10 w-sm max-w-sm rounded-md border p-1">
        <div className="flex items-start gap-2 rounded-sm px-3 py-2">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="mt-0.5 size-4 rounded-sm" />
        </div>
      </div>
      <div className="bg-card absolute bottom-4 left-4 z-10 flex flex-col gap-px overflow-hidden rounded-md border p-1">
        <Skeleton className="size-6.5 rounded-sm" />
        <Skeleton className="size-6.5 rounded-sm" />
        <Skeleton className="size-6.5 rounded-sm" />
      </div>
      <div className="absolute top-[53%] right-10 left-9 -translate-y-1/2">
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
        <div className="bg-sidebar-ring/45 absolute top-1/2 left-full ml-2.5 h-px w-9 -translate-y-1/2" />
      )}
      <div className={`bg-card/95 rounded-sm border p-1.5 shadow-sm ${widthClassName}`}>
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
