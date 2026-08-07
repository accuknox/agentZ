import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function InheritedResourcesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/settings/inherited/skills` as Route)
}
