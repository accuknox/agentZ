import { notFound } from "next/navigation"
import { getRoleEditorData } from "@/data/roles"
import { RoleEditor } from "../../role-editor"

export default async function RolePermissionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string }>
}) {
  const { orgSlug, roleId: encodedRoleId } = await params
  const roleId = decodeURIComponent(encodedRoleId)
  const data = await getRoleEditorData(orgSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  return <RoleEditor data={data} />
}
