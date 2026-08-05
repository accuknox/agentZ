import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function WorkspaceRolePage({
  params,
}: {
  params: Promise<{ orgSlug: string; roleId: string; workspaceSlug: string }>
}) {
  const { orgSlug, roleId, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/roles/${roleId}/permissions` as Route)
}
