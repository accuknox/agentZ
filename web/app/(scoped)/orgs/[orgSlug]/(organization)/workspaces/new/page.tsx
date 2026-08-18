import { AdministrationState } from "@/components/administration"
import { getWorkspaceCreation } from "@/data/workspaces"
import { WorkspaceForm } from "./workspace-form"

export const unstable_instant = false

export const metadata = { title: "New workspace" }

export default async function NewWorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const result = await getWorkspaceCreation(orgSlug)
  if (result.scope.kind !== "ready") {
    return null
  }
  if (!result.candidates) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <WorkspaceForm
      candidates={result.candidates}
      orgSlug={result.scope.organization.slug}
      resources={result.resources}
    />
  )
}
