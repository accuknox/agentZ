import type { Route } from "next"
import { redirect } from "next/navigation"

export const metadata = { title: "Inherited resources" }

export default async function WorkspaceInheritancePage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}/inherited/skills` as Route)
}
