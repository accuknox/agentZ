import { notFound } from "next/navigation"
import { getOrganizationRoleUsers } from "@/data/roles"
import { RoleAssignments } from "../../role-assignments"

export const metadata = { title: "Assignments" }

export default async function RoleAssignmentsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId: encodedRoleId } = await params
  const roleId = decodeURIComponent(encodedRoleId)
  const data = await getOrganizationRoleUsers(orgSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  return (
    <RoleAssignments
      immutable={data.role.systemRole !== "superadmin" && data.role.immutable}
      name={data.role.name}
      orgSlug={orgSlug}
      roleId={roleId}
      users={data.users}
    />
  )
}
