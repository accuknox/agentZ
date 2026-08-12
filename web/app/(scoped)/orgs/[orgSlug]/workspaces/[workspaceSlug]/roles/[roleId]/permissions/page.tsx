import { notFound } from "next/navigation"
import { RoleEditor } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-editor"
import { getWorkspaceRoleEditorData } from "@/data/roles"

export default async function WorkspaceRolePermissionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId: encodedRoleId, workspaceSlug } = await params
  const roleId = decodeURIComponent(encodedRoleId)
  const data = await getWorkspaceRoleEditorData(orgSlug, workspaceSlug, roleId)
  if (!data?.role) {
    notFound()
  }

  return <RoleEditor data={data} />
}
