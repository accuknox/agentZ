import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import InferencePoolsPage from "@/app/(app)/inference/pools/pool-page"

export default async function WorkspaceInferencePoolsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.inference_pool_capabilities.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  return (
    <InferencePoolsPage
      capabilities={scope.workspace.inference_pool_capabilities}
      scope={{ basePath, workspaceId: scope.workspace.id }}
    />
  )
}
