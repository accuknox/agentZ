import type { Route } from "next"
import { redirect } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { getWorkspaceDirectory } from "@/data/workspaces"

export const unstable_instant = false

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const result = await getWorkspaceDirectory(orgSlug)
  if (result.scope.kind !== "ready" || !result.directory) {
    return null
  }

  const root = `/orgs/${result.scope.organization.slug}`
  if (result.directory.can_enter_organization) {
    redirect(`${root}/workspaces` as Route)
  }
  const [workspace] = result.directory.workspaces
  if (workspace) {
    redirect(`${root}/workspaces/${workspace.slug}` as Route)
  }

  return (
    <AdministrationState
      description="No workspace access is assigned to your account."
      kind="empty"
      title="No Workspace access"
    />
  )
}
