import { notFound } from "next/navigation"
import { getRoleEditorData } from "@/data/roles"
import { RoleDelete } from "../../role-delete"
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

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <RoleEditor data={data} />
      {!data.role.immutable ? (
        <RoleDelete name={data.role.name} orgSlug={orgSlug} roleId={roleId} />
      ) : null}
    </div>
  )
}
