import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getRoleEditorData } from "@/data/roles"
import { RoleEditor } from "../role-editor"

export const metadata = { title: "New role" }

export default function NewRolePage(props: PageProps<"/orgs/[orgSlug]/roles/new">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <NewRoleContent {...props} />
    </Suspense>
  )
}

async function NewRoleContent({ params }: PageProps<"/orgs/[orgSlug]/roles/new">) {
  const { orgSlug } = await params
  const data = await getRoleEditorData(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return <RoleEditor data={data} />
}
