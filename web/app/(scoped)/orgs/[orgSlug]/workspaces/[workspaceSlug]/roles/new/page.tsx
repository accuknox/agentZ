import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceRoleEditorData } from "@/data/roles"
import { RoleEditor } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/roles/role-editor"

export const metadata = { title: "New role" }

export default function NewWorkspaceRolePage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/roles/new">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <NewWorkspaceRoleContent {...props} />
    </Suspense>
  )
}

async function NewWorkspaceRoleContent({
  params,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/roles/new">) {
  const { orgSlug, workspaceSlug } = await params
  const data = await getWorkspaceRoleEditorData(orgSlug, workspaceSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return <RoleEditor data={data} />
}
