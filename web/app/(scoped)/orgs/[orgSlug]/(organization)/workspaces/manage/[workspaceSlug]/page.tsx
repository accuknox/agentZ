import { notFound } from "next/navigation"
import { RoleAssignments } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-assignments"
import { AdministrationState } from "@/components/administration"
import { getWorkspaceRoleUsers, listWorkspaceRoles } from "@/data/roles"
import { getWorkspaceScope } from "@/data/workspaces"
import { WorkspaceGeneralForm } from "./workspace-general-form"

export default async function ManageWorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const [scope, roles] = await Promise.all([
    getWorkspaceScope(orgSlug, workspaceSlug),
    listWorkspaceRoles(orgSlug, workspaceSlug),
  ])
  if (scope.scope.kind !== "ready" || !scope.scope.organization.superadmin || !roles) {
    return <AdministrationState kind="forbidden" />
  }
  if (scope.kind !== "ready") notFound()
  const adminRole = roles.roles.find((role) => role.systemRole === "workspace_admin")
  if (!adminRole) notFound()
  const assignments = await getWorkspaceRoleUsers(orgSlug, workspaceSlug, adminRole.id)
  if (!assignments?.role) notFound()

  return (
    <div className="flex min-w-0 flex-col gap-8 pb-6">
      <section className="flex flex-col gap-4">
        <h2 className="px-4 text-lg font-medium md:px-6">Workspace Details</h2>
        <WorkspaceGeneralForm
          name={scope.workspace.name}
          orgSlug={orgSlug}
          workspaceId={scope.workspace.id}
        />
      </section>
      <section className="flex flex-col gap-4">
        <RoleAssignments
          immutable={false}
          name="Workspace Admin"
          orgSlug={orgSlug}
          roleId={adminRole.id}
          users={assignments.users}
          workspaceSlug={workspaceSlug}
        />
      </section>
    </div>
  )
}
