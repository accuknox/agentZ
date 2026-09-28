import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import {
  AdministrationLoadingState,
  AdministrationPageHeader,
  AdministrationState,
} from "@/components/administration"
import { RememberPageSelection } from "@/components/page-selection"
import { resolvePageSelection } from "@/data/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema } from "@/lib/search-params"
import { WorkflowsFilters } from "../graphs/workflows-filters"
import { Evaluations } from "./evaluations"

export const metadata: Metadata = { title: "Workflow evaluations" }
const searchSchema = z.object({
  agent_name: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
})

export default function EvaluationsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">
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
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">) {
  const [route, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  const { selected, requested, agents, workflows, workflow, error } = await resolvePageSelection(
    scope,
    "workflows/evaluations",
    searchSchema.parse(search)
  )
  if (error) return <AdministrationState kind="failed" description={error.message} />
  return (
    <>
      <RememberPageSelection selected={selected} requested={requested} />
      <WorkflowsFilters
        agents={agents}
        workflows={workflows}
        selectedAgentName={selected.agent_name}
        selectedWorkflowName={selected.workflow_name}
      />
      {workflow ? (
        <Evaluations
          key={`${workflow.agent_name}:${workflow.workflow_name}`}
          workflow={workflow}
          workspaceId={scope.workspace.id}
        />
      ) : (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          {agents.length ? "No workflows available" : "No agents available"}
        </div>
      )}
    </>
  )
}
