import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import SandboxesPage from "@/app/(app)/sandboxes/sandbox-page"

export const metadata = { title: "Sandboxes" }

export default function WorkspaceSandboxesPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/sandboxes">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceSandboxes {...props} />
    </Suspense>
  )
}

async function WorkspaceSandboxes({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/sandboxes">) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.sandboxes.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/sandboxes`
  return (
    <SandboxesPage
      basePath={basePath}
      capabilities={scope.workspace.capabilities.sandboxes}
      pageScope={{
        kind: "workspace",
        organizationName: scope.scope.organization.name,
        workspaceName: scope.workspace.name,
      }}
      searchParams={searchParams}
      workspaceId={scope.workspace.id}
    />
  )
}
