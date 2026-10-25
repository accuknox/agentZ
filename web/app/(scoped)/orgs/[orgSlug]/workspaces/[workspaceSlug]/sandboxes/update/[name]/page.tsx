import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import UpdateSandboxPage, { generateMetadata } from "@/app/(app)/sandboxes/update-sandbox-page"

export { generateMetadata }

export default function UpdateWorkspaceSandboxPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/sandboxes/update/[name]">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <UpdateWorkspaceSandboxContent {...props} />
    </Suspense>
  )
}

async function UpdateWorkspaceSandboxContent({
  params,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/sandboxes/update/[name]">) {
  const values = await params
  const scope = await getWorkspaceScope(values.orgSlug, values.workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.sandboxes.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/sandboxes`
  return (
    <UpdateSandboxPage
      basePath={basePath}
      params={Promise.resolve({ name: values.name })}
      providersHref={{
        pathname: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/inference/providers`,
      }}
      workspaceId={scope.workspace.id}
    />
  )
}
