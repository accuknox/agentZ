import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function InheritedWorkspaceTabRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; resourceTab: string; workspaceSlug: string }>
}) {
  const { orgSlug, resourceTab, workspaceSlug } = await params
  redirect(
    `/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}/inherited/${resourceTab}` as Route
  )
}
