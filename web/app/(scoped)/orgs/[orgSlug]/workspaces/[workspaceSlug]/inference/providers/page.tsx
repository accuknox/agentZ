import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import InferenceProvidersPage from "@/app/(app)/inference/providers/provider-page"

export default async function WorkspaceInferenceProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const { page_token } = await searchParams
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.inference_providers.read)
    return <AdministrationState kind="forbidden" />
  return (
    <InferenceProvidersPage
      capabilities={scope.workspace.capabilities.inference_providers}
      pageToken={page_token}
      scope={{ workspaceId: scope.workspace.id }}
    />
  )
}
