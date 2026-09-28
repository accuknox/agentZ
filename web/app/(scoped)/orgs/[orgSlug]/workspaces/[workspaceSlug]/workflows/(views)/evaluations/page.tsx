import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { RememberPageSelection } from "@/components/page-selection"
import { resolvePageSelection } from "@/data/page-selection"
import { getWorkspaceScope } from "@/data/workspaces"
import { searchParamStringSchema } from "@/lib/search-params"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
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
    <Suspense fallback={<AdministrationLoadingState />}>
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
  if (scope.kind !== "ready" || scope.workspace.type === "coding") notFound()
  const [selection, providers] = await Promise.all([
    resolvePageSelection(scope, "workflows/evaluations", searchSchema.parse(search)),
    listInferenceProvidersCachedQuery(scope.workspace.id),
  ])
  const { selected, requested, agents, workflow, error } = selection
  const providerBrands = Object.fromEntries(
    (providers.providers ?? []).map((provider) => [provider.id, provider.catalog_provider])
  )
  if (error) return <AdministrationState kind="failed" description={error.message} />
  return (
    <>
      <RememberPageSelection selected={selected} requested={requested} />
      {workflow ? (
        <Evaluations
          key={`${workflow.agent_name}:${workflow.workflow_name}`}
          workflow={workflow}
          workspaceId={scope.workspace.id}
          providerBrands={providerBrands}
        />
      ) : (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          {agents.length ? "No workflows available" : "No agents available"}
        </div>
      )}
    </>
  )
}
