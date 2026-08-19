import type { Route } from "next"
import { redirect } from "next/navigation"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { getWorkspaceDirectory } from "@/data/workspaces"

export const unstable_instant = false

export const metadata = { title: "Overview" }

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
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Overview" />
      <AdministrationState
        description="Your Roles and Teams do not grant access to any Workspace."
        kind="empty"
        title="No Workspace access"
      />
    </div>
  )
}
