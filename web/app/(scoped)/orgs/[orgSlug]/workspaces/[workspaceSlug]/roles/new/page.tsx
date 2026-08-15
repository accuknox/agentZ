import { AdministrationState } from "@/components/administration"
import { getWorkspaceRoleEditorData } from "@/data/roles"
import { RoleEditor } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-editor"

export const metadata = { title: "New role" }

export default async function NewWorkspaceRolePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const data = await getWorkspaceRoleEditorData(orgSlug, workspaceSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return <RoleEditor data={data} />
}
