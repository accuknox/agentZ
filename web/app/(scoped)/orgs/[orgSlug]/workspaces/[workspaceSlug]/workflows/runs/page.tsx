import { Suspense } from "react"
import { notFound } from "next/navigation"
import { z } from "zod"
import { AdministrationLoadingState, AdministrationPageHeader } from "@/components/administration"
import { RememberPageSelection } from "@/components/page-selection"
import { resolvePageSelection } from "@/data/page-selection"
import { deleteWorkflowRunAction } from "@/data/workflow-run.actions"
import { listWorkflowRunsCachedQuery } from "@/data/workflow-run.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema } from "@/lib/search-params"
import { WorkflowsFilters } from "../graphs/workflows-filters"
import { RunsTable } from "../triggers/runs/runs-table"

export const metadata = { title: "Workflow runs" }

export default function WorkflowRunsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/runs">
) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AdministrationPageHeader title="Workflows" />
      <Suspense fallback={<AdministrationLoadingState />}>
        <Content {...props} />
      </Suspense>
    </main>
  )
}

async function Content({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/runs">) {
  const [route, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  const requested = z
    .object({
      agent_name: searchParamStringSchema,
      workflow_name: searchParamStringSchema,
      page_token: searchParamStringSchema,
    })
    .parse(search)
  const state = await resolvePageSelection(scope, "workflows/runs", requested)
  if (state.error)
    return (
      <p role="alert" className="text-destructive p-6">
        {state.error.message}
      </p>
    )
  const actionScope = {
    basePath: `/orgs/${route.orgSlug}/workspaces/${route.workspaceSlug}`,
    workspaceId: scope.workspace.id,
  }
  const workflow = state.workflow
  const result = workflow
    ? await listWorkflowRunsCachedQuery(
        workflow.agent_name,
        workflow.workflow_name,
        scope.workspace.id,
        {
          limit: 25,
          page_token:
            state.selected.agent_name === requested.agent_name &&
            state.selected.workflow_name === requested.workflow_name
              ? requested.page_token
              : undefined,
        }
      )
    : undefined
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <WorkflowsFilters
        agents={state.agents}
        workflows={state.workflows}
        selectedAgentName={state.selected.agent_name}
        selectedWorkflowName={state.selected.workflow_name}
      />
      {result?.error ? (
        <p role="alert" className="text-destructive p-6">
          {result.error.message}
        </p>
      ) : workflow && result ? (
        <RunsTable
          agentName={workflow.agent_name}
          workflowName={workflow.workflow_name}
          basePath={actionScope.basePath}
          workspaceId={scope.workspace.id}
          deleteWorkflowRunAction={deleteWorkflowRunAction.bind(null, actionScope)}
          hasNextPage={result.hasNextPage}
          nextPageToken={result.nextPageToken}
          workflowRuns={result.workflowRuns}
        />
      ) : (
        <p className="text-muted-foreground p-8 text-center">
          Choose an agent and workflow to view its runs.
        </p>
      )}
    </>
  )
}
