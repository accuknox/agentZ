import { notFound } from "next/navigation"
import { RoleDelete } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-delete"
import { RoleEditor } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-editor"
import { getWorkspaceRoleEditorData } from "@/data/roles"

export default async function WorkspaceRolePermissionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId, workspaceSlug } = await params
  const data = await getWorkspaceRoleEditorData(orgSlug, workspaceSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <RoleEditor data={data} />
      {!data.role.immutable ? (
        <RoleDelete
          name={data.role.name}
          orgSlug={orgSlug}
          roleId={roleId}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
    </div>
  )
}
