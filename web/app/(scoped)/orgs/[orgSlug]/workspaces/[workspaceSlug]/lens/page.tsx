import type { Route } from "next"
import { redirect } from "next/navigation"

export const metadata = { title: "Lens" }

export default async function LensPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/${workspaceSlug}/lens/traces` as Route)
}
