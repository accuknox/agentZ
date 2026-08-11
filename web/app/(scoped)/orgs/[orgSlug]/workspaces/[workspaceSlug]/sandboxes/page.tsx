import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import SandboxesPage from "@/app/(app)/sandboxes/sandbox-page"

export default async function WorkspaceSandboxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.sandbox_capabilities.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/sandboxes`
  return (
    <SandboxesPage
      basePath={basePath}
      capabilities={scope.workspace.sandbox_capabilities}
      searchParams={searchParams}
      workspaceId={scope.workspace.id}
    />
  )
}
