import { notFound } from "next/navigation"
import { RoleAssignments } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-assignments"
import { getWorkspaceRoleUsers } from "@/data/roles"

export default async function WorkspaceRoleAssignmentsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId, workspaceSlug } = await params
  const data = await getWorkspaceRoleUsers(orgSlug, workspaceSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  const assignmentsReadOnly =
    data.role.immutable && (data.role.systemRole !== "workspace_admin" || !data.superadmin)

  return (
    <RoleAssignments
      immutable={assignmentsReadOnly}
      name={data.role.name}
      orgSlug={orgSlug}
      roleId={roleId}
      users={data.users}
      workspaceSlug={workspaceSlug}
    />
  )
}
