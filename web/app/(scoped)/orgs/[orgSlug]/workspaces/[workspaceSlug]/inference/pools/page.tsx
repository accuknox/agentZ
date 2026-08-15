import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import InferencePoolsPage from "@/app/(app)/inference/pools/pool-page"

export const metadata = { title: "Pools" }

export default async function WorkspaceInferencePoolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const { page_token } = await searchParams
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.inference_pools.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  return (
    <InferencePoolsPage
      capabilities={scope.workspace.capabilities.inference_pools}
      pageToken={page_token}
      scope={{ basePath, workspaceId: scope.workspace.id }}
    />
  )
}
