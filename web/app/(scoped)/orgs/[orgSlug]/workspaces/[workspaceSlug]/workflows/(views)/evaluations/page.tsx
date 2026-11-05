import { RequestError } from "@/components/request-error"
import { RememberRoute } from "@/data/route-memory"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import { AdministrationState } from "@/components/administration"
import { RememberPageSelection } from "@/components/page-selection"
import { resolvePageSelection } from "@/data/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema } from "@/lib/search-params"
import { Evaluations, EvaluationsSkeleton } from "./evaluations"

export const metadata: Metadata = { title: "Workflow evaluations" }
const searchSchema = z.object({
  agent_name: searchParamStringSchema,
  workflow_name: searchParamStringSchema,
})

export default function EvaluationsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">
) {
  return (
    <Suspense fallback={<EvaluationsSkeleton />}>
      <Content {...props} />
    </Suspense>
  )
}

async function Content({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/workflows/evaluations">) {
  const [route, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(route.orgSlug, route.workspaceSlug)
  if (scope.kind === "error")
    return <RequestError title="Could not load this workspace" error={scope.error} />
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  const state = await resolvePageSelection(
    scope,
    "workflows/evaluations",
    searchSchema.parse(search)
  )
  const { workflow, agents, error } = state
  if (error)
    return (
      <>
        <RememberPageSelection {...state} />
        <AdministrationState
          kind="failed"
          title="Could not load evaluations"
          description={error.message}
        />
      </>
    )
  return (
    <>
      <RememberRoute />
      <RememberPageSelection {...state} />
      {workflow ? (
        <Evaluations
          key={`${workflow.agent_name}:${workflow.workflow_name}`}
          workflow={workflow}
          workspaceId={scope.workspace.id}
        />
      ) : (
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          {agents.length ? "No workflows available" : "No agents available"}
        </div>
      )}
    </>
  )
}
