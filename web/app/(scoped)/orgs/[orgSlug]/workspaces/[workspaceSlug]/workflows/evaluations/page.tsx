import { Suspense } from "react"
import { notFound } from "next/navigation"
import {
  AdministrationLoadingState,
  AdministrationPageHeader,
  AdministrationState,
} from "@/components/administration"
import { RememberPageSelection } from "@/components/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { resolvePageSelection } from "@/data/page-selection"
import { listWorkflowEvaluations } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { WorkflowsFilters } from "../graphs/workflows-filters"
import { Evaluations } from "./evaluations"
import { z } from "zod"
import { searchParamStringSchema } from "@/lib/search-params"

export const metadata = { title: "Workflow evaluations" }

export default function EvaluationsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">
) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
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
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">) {
  const [route, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  const requested = z
    .object({ agent_name: searchParamStringSchema, workflow_name: searchParamStringSchema })
    .parse(search)
  const state = await resolvePageSelection(scope, "workflows/evaluations", requested)
  if (state.error)
    return (
      <p role="alert" className="text-destructive p-6">
        {state.error.message}
      </p>
    )
  const { data, error } = state.workflow
    ? await listWorkflowEvaluations({
        client: getGatewayServerClient(scope.workspace.id),
        headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
        path: { agentName: state.workflow.agent_name, workflowName: state.workflow.workflow_name },
      })
    : { data: [], error: undefined }
  return (
    <>
      <RememberPageSelection selected={state.selected} requested={state.requested} />
      <WorkflowsFilters
        agents={state.agents}
        workflows={state.workflows}
        selectedAgentName={state.selected.agent_name}
        selectedWorkflowName={state.selected.workflow_name}
      />
      {error ? (
        <p role="alert" className="text-destructive p-6">
          {error.message}
        </p>
      ) : state.workflow ? (
        <Evaluations
          key={`${state.workflow.agent_name}:${state.workflow.workflow_name}`}
          workspaceId={scope.workspace.id}
          workflow={state.workflow}
          initial={data}
        />
      ) : (
        <AdministrationState
          kind="empty"
          title="Select a workflow"
          description="Choose an agent and workflow above to view evaluations."
        />
      )}
    </>
  )
}
