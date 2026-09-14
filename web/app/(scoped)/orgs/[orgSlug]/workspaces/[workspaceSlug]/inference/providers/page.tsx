import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { searchParamStringSchema } from "@/lib/search-params"
import { getWorkspaceScope } from "@/data/workspaces"
import InferenceProvidersPage from "@/app/(app)/inference/providers/provider-page"

export const metadata = { title: "Inference providers" }

export default function WorkspaceInferenceProvidersPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/inference/providers">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceInferenceProviders {...props} />
    </Suspense>
  )
}

async function WorkspaceInferenceProviders({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/inference/providers">) {
  const { orgSlug, workspaceSlug } = await params
  const { page_token } = await searchParams
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.inference_providers.read)
    return <AdministrationState kind="forbidden" />
  return (
    <InferenceProvidersPage
      capabilities={scope.workspace.capabilities.inference_providers}
      pageToken={searchParamStringSchema.parse(page_token)}
      pageScope={{
        kind: "workspace",
        organizationName: scope.scope.organization.name,
        workspaceName: scope.workspace.name,
      }}
      scope={{ workspaceId: scope.workspace.id }}
    />
  )
}
