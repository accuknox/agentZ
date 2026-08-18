import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import NewSandboxPage from "@/app/(app)/sandboxes/new-sandbox-page"

export const metadata = { title: "New sandbox" }

export default async function NewWorkspaceSandboxPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.capabilities.sandboxes.create)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/sandboxes`
  return (
    <NewSandboxPage
      basePath={basePath}
      providersHref={{
        pathname: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/inference/providers`,
      }}
      workspaceId={scope.workspace.id}
    />
  )
}
