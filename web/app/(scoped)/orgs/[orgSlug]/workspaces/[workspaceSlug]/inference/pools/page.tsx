import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { searchParamStringSchema } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"
import InferencePoolsPage from "@/app/(app)/inference/pools/pool-page"

export const metadata = { title: "Pools" }

export default function WorkspaceInferencePoolsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/inference/pools">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceInferencePools {...props} />
    </Suspense>
  )
}

async function WorkspaceInferencePools({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/inference/pools">) {
  const { orgSlug, workspaceSlug } = await params
  const { page_token } = await searchParams
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.inference_pools.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  return (
    <InferencePoolsPage
      capabilities={scope.workspace.capabilities.inference_pools}
      pageToken={searchParamStringSchema.parse(page_token)}
      scope={{ basePath, workspaceId: scope.workspace.id }}
    />
  )
}
