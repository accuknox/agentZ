import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import InferenceProvidersPage from "@/app/(app)/inference/providers/provider-page"

export default async function WorkspaceInferenceProvidersPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.inference_provider_capabilities.read)
    return <AdministrationState kind="forbidden" />
  return (
    <InferenceProvidersPage
      capabilities={scope.workspace.inference_provider_capabilities}
      scope={{ workspaceId: scope.workspace.id }}
      scopeLabel="Local"
    />
  )
}
