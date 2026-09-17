import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription } from "@/components/ui/alert"
import * as z from "zod"
import { Skeleton } from "@/components/ui/skeleton"
import { resolvePageSelection } from "@/data/page-selection"
import { RememberPageSelection } from "@/components/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema } from "@/lib/search-params"
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

export default function WorkflowRunGraphPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs/graph">
) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <AdministrationPageHeader title="Workflow run graph" />
      <Suspense fallback={<GraphSkeleton />}>
        <WorkflowRunGraphContent {...props} />
      </Suspense>
    </main>
  )
}

async function WorkflowRunGraphContent({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/triggers/runs/graph">) {
  const [route, search] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (workspace.kind !== "ready" || workspace.workspace.type === "coding") {
    notFound()
  }
  const parsed = workflowRunGraphSearchParamsSchema.parse(search)
  const state = await resolvePageSelection(workspace, "workflows/triggers/runs/graph", parsed)
  if (state.error) return <ErrorPanel message={state.error.message} />
  const { selected, workflow, workflowRun } = state
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <WorkflowRunGraphFilters
        agents={state.agents}
        workflows={state.workflows}
        workflowRuns={state.workflowRuns}
        selectedAgentName={state.selected.agent_name}
        selectedWorkflowName={state.selected.workflow_name}
        selectedRunName={state.selected.run_name}
      />
      {!selected.agent_name ? (
        <EmptyState message="No agents available" />
      ) : !selected.workflow_name ? (
        <EmptyState message={`No workflows available for ${selected.agent_name}`} />
      ) : !workflow || !workflowRun ? (
        <EmptyState message={`No workflow runs available for ${selected.workflow_name}`} />
      ) : (
        <WorkflowRunGraph
          key={`${selected.agent_name}:${selected.workflow_name}:${selected.run_name}`}
          agentName={selected.agent_name}
          workflow={workflow}
          workflowRun={workflowRun}
          workspaceId={workspace.workspace.id}
        />
      )}
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
    <Alert className="px-6" variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
