import type { Route } from "next"
import { redirect } from "next/navigation"

export default async function ObservabilityPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/observability/traces` as Route)
}
