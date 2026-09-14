import { AdministrationLoadingState } from "@/components/administration"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getRoleEditorData } from "@/data/roles"
import { RoleEditor } from "../../role-editor"

export const metadata = { title: "Permissions" }

export default function RolePermissionsPage(
  props: PageProps<"/orgs/[orgSlug]/roles/[roleId]/permissions">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <RolePermissionsContent {...props} />
    </Suspense>
  )
}

async function RolePermissionsContent({
  params,
}: PageProps<"/orgs/[orgSlug]/roles/[roleId]/permissions">) {
  const { orgSlug, roleId: encodedRoleId } = await params
  const roleId = decodeURIComponent(encodedRoleId)
  const data = await getRoleEditorData(orgSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  return <RoleEditor data={data} />
}
