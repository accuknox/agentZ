import { AdministrationLoadingState } from "@/components/administration"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getOrganizationRoleUsers } from "@/data/roles"
import { RoleAssignments } from "../../role-assignments"

export const metadata = { title: "Assignments" }

export default function RoleAssignmentsPage(
  props: PageProps<"/orgs/[orgSlug]/roles/[roleId]/assignments">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <RoleAssignmentsContent {...props} />
    </Suspense>
  )
}

async function RoleAssignmentsContent({
  params,
}: PageProps<"/orgs/[orgSlug]/roles/[roleId]/assignments">) {
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
