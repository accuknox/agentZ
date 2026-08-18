import { AdministrationState } from "@/components/administration"
import { getRoleEditorData } from "@/data/roles"
import { RoleEditor } from "../role-editor"

export const metadata = { title: "New role" }

export default async function NewRolePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const data = await getRoleEditorData(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return <RoleEditor data={data} />
}
