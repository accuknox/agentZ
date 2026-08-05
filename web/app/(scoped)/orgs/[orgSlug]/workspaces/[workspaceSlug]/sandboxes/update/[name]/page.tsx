import { AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import UpdateSandboxPage, { generateMetadata } from "@/app/(app)/sandboxes/update-sandbox-page"

export { generateMetadata }

export default async function UpdateWorkspaceSandboxPage({
  params,
}: {
  params: Promise<{ name: string; orgSlug: string; workspaceSlug: string }>
}) {
  const values = await params
  const scope = await getWorkspaceScope(values.orgSlug, values.workspaceSlug)
  if (scope.kind !== "ready" || !scope.workspace.sandbox_capabilities.read)
    return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/sandboxes`
  return (
    <UpdateSandboxPage
      basePath={basePath}
      params={Promise.resolve({ name: values.name })}
      workspaceId={scope.workspace.id}
    />
  )
}
