import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import {
  selectWorkflowRunGraphFiltersAction,
  type WorkflowActionScope,
} from "@/data/workflow.actions"
import { getWorkflowCachedQuery, listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { getWorkflowRunCachedQuery, listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { WorkflowRunGraphFilters } from "./workflow-run-graph-filters"
import { WorkflowRunGraph } from "./workflow-run-graph"

export const metadata: Metadata = {
  title: "Workflow Run Graph",
}

const workflowRunGraphSearchParamsSchema = z.object({
  agent_name: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
  run_name: searchParamStringSchema,
})

type SearchParams = {
  agent_name?: SearchParamStringInput
  workflow_name?: SearchParamStringInput
  run_name?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof workflowRunGraphSearchParamsSchema>

export default async function WorkflowRunGraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready") {
    notFound()
  }
  const parsed = workflowRunGraphSearchParamsSchema.parse(search)
  const actionScope: WorkflowActionScope = {
    basePath: `/orgs/${workspace.scope.organization.slug}/workspaces/${workspace.workspace.slug}`,
    workspaceId: workspace.workspace.id,
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Workflow Run Graph</h1>
        </div>
      </div>
      <Suspense fallback={<GraphSkeleton />}>
        <WorkflowRunGraphContent actionScope={actionScope} searchParams={parsed} />
      </Suspense>
    </main>
  )
}

async function WorkflowRunGraphContent({
  actionScope,
  searchParams,
}: {
  actionScope: WorkflowActionScope
  searchParams: ResolvedSearchParams
}) {
  const agentsResult = await listAgentsCachedQuery(undefined, actionScope.workspaceId)
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === searchParams.agent_name) ??
    agentsResult.agents[0]
  if (!selectedAgent) {
    return (
      <>
        <WorkflowRunGraphFilters
          action={selectWorkflowRunGraphFiltersAction.bind(null, actionScope)}
          agents={agentsResult.agents}
          workflowRuns={[]}
          workflows={[]}
        />
        <EmptyState message="No agents available" />
      </>
    )
  }

  const workflowsResult = await listWorkflowSummariesCachedQuery(
    selectedAgent.name,
    actionScope.workspaceId
  )
  if (workflowsResult.error) {
    return <ErrorPanel message={workflowsResult.error.message} />
  }

  const selectedWorkflow =
    workflowsResult.summaries.find(
      (workflow) => workflow.workflow_name === searchParams.workflow_name
    ) ?? workflowsResult.summaries[0]
  if (!selectedWorkflow) {
    return (
      <>
        <WorkflowRunGraphFilters
          action={selectWorkflowRunGraphFiltersAction.bind(null, actionScope)}
          agents={agentsResult.agents}
          selectedAgentName={selectedAgent.name}
          workflowRuns={[]}
          workflows={workflowsResult.summaries}
        />
        <EmptyState message={`No workflows available for ${selectedAgent.name}`} />
      </>
    )
  }

  const runsResult = await listWorkflowRunsCachedQuery(
    selectedAgent.name,
    selectedWorkflow.workflow_name,
    actionScope.workspaceId,
    {
      limit: 200,
    }
  )
  if (runsResult.error) {
    return <ErrorPanel message={runsResult.error.message} />
  }

  const selectedRun =
    runsResult.workflowRuns.find((run) => run.name === searchParams.run_name) ??
    runsResult.workflowRuns[0]
  if (!selectedRun) {
    return (
      <>
        <WorkflowRunGraphFilters
          action={selectWorkflowRunGraphFiltersAction.bind(null, actionScope)}
          agents={agentsResult.agents}
          selectedAgentName={selectedAgent.name}
          selectedWorkflowName={selectedWorkflow.workflow_name}
          workflowRuns={runsResult.workflowRuns}
          workflows={workflowsResult.summaries}
        />
        <EmptyState message={`No workflow runs available for ${selectedWorkflow.workflow_name}`} />
      </>
    )
  }

  const [workflowResult, runResult] = await Promise.all([
    getWorkflowCachedQuery(
      selectedAgent.name,
      selectedWorkflow.workflow_name,
      actionScope.workspaceId
    ),
    getWorkflowRunCachedQuery(
      selectedAgent.name,
      selectedWorkflow.workflow_name,
      selectedRun.name,
      actionScope.workspaceId
    ),
  ])
  if (workflowResult.error) {
    return <ErrorPanel message={workflowResult.error.message} />
  }
  if (runResult.error) {
    return <ErrorPanel message={runResult.error.message} />
  }
  if (!workflowResult.workflow) {
    return <ErrorPanel message="Workflow data is unavailable" />
  }

  return (
    <>
      <WorkflowRunGraphFilters
        action={selectWorkflowRunGraphFiltersAction.bind(null, actionScope)}
        agents={agentsResult.agents}
        selectedAgentName={selectedAgent.name}
        selectedRunName={selectedRun.name}
        selectedWorkflowName={selectedWorkflow.workflow_name}
        workflowRuns={runsResult.workflowRuns}
        workflows={workflowsResult.summaries}
      />
      <WorkflowRunGraph
        key={`${selectedAgent.name}:${selectedWorkflow.workflow_name}:${selectedRun.name}`}
        agentName={selectedAgent.name}
        workflow={workflowResult.workflow}
        workflowRun={runResult.workflowRun}
        workspaceId={actionScope.workspaceId}
      />
    </>
  )
}

function GraphSkeleton() {
  return (
    <>
      <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:px-6">
        <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52" />
        <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-72 sm:min-w-52" />
        <Skeleton className="h-8 w-full min-w-0 rounded-md sm:w-80 sm:min-w-64" />
      </div>
      <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-t">
        <div className="absolute top-[53%] right-10 left-9 -translate-y-1/2">
          <div className="flex min-w-max items-center gap-12">
            <Skeleton className="h-28 w-76 rounded-xl" />
            <Skeleton className="h-28 w-76 rounded-xl" />
            <Skeleton className="h-28 w-76 rounded-xl" />
          </div>
        </div>
      </div>
    </>
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
