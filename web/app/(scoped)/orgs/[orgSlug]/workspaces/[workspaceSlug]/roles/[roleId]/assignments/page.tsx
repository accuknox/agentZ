import { AdministrationLoadingState } from "@/components/administration"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { RoleAssignments } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-assignments"
import { getWorkspaceRoleUsers } from "@/data/roles"

export const metadata = { title: "Assignments" }

export default function WorkspaceRoleAssignmentsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/roles/[roleId]/assignments">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceRoleAssignmentsContent {...props} />
    </Suspense>
  )
}

async function WorkspaceRoleAssignmentsContent({
  params,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/roles/[roleId]/assignments">) {
  const { orgSlug, roleId: encodedRoleId, workspaceSlug } = await params
  const roleId = decodeURIComponent(encodedRoleId)
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
