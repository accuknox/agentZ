import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function DeleteWorkspaceRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}/delete` as Route)
}
