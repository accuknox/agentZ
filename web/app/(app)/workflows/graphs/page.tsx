import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import Workflow from "@/components/blocks/workflow/workflow"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { selectWorkflowFiltersAction } from "@/data/workflow.actions"
import { listWorkflowSummariesCachedQuery, getWorkflowCachedQuery } from "@/data/workflow.queries"
import { WorkflowsFilters } from "./workflows-filters"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Workflow Graphs",
}

const workflowsSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
})

type SearchParams = {
  agent_name?: SearchParamStringInput
  workflow_name?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof workflowsSearchParamsSchema>

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = workflowsSearchParamsSchema.parse(await searchParams)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
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

async function Filters({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const agents = listAgentsCachedQuery()
  const selectedAgentName = searchParams.agent_name
  const selectedWorkflowName = searchParams.workflow_name
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === selectedAgentName) ?? agentsResult.agents[0]
  if (!selectedAgent) {
    return (
      <WorkflowsFilters
        action={selectWorkflowFiltersAction}
        agents={agentsResult.agents}
        selectedAgentName={undefined}
        workflows={[]}
        selectedWorkflowName={undefined}
      />
    )
  }

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

async function WorkflowContent({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const agents = listAgentsCachedQuery()
  const selectedAgentName = searchParams.agent_name
  const selectedWorkflowName = searchParams.workflow_name
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
    <div className="bg-background border-b px-4 py-2 sm:px-6">
      <div className="flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52" />
          <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52" />
        </div>
      </div>
    </div>
  )
}

function CanvasSkeleton() {
  return (
    <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-t">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[14px_14px] opacity-35" />
        <div className="from-background/22 absolute inset-x-0 top-0 h-32 bg-linear-to-b to-transparent" />
      </div>
      <div className="bg-card/88 border-border/70 absolute top-4 left-4 z-10 w-[calc(100vw-2rem)] max-w-sm rounded-lg border p-1 shadow-lg shadow-black/5 backdrop-blur-md sm:w-sm">
        <div className="flex items-start gap-2 rounded-md px-3 py-2.5">
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
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton />
          <WorkflowNodeSkeleton isLast />
        </div>
      </div>
    </div>
  )
}

function WorkflowNodeSkeleton({ isLast = false }: { isLast?: boolean }) {
  return (
    <div className="relative shrink-0">
      {isLast ? null : (
        <div className="bg-sidebar-ring/45 absolute top-1/2 left-full ml-2.5 h-px w-9 -translate-y-1/2" />
      )}
      <div className="bg-background/94 border-border/70 dark:bg-accent/82 w-[20rem] rounded-xl border p-4 shadow-[0_16px_40px_-30px_rgb(15_23_42/0.45)]">
        <div className="flex items-center justify-between gap-5">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-4 w-7" />
            </div>
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-4 w-7" />
            </div>
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
