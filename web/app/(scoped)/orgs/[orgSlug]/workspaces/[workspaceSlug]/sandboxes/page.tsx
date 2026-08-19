import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import SandboxesPage from "@/app/(app)/sandboxes/sandbox-page"

export const metadata = { title: "Sandboxes" }

export default async function WorkspaceSandboxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
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
