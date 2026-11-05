import { RequestError } from "@/components/request-error"
import { RememberRoute } from "@/data/route-memory"
import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceCreation } from "@/data/workspaces"
import { WorkspaceForm } from "./workspace-form"

export const metadata = { title: "New workspace" }

export default function NewWorkspacePage(props: PageProps<"/orgs/[orgSlug]/workspaces/new">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <NewWorkspaceContent {...props} />
    </Suspense>
  )
}

async function NewWorkspaceContent({ params }: PageProps<"/orgs/[orgSlug]/workspaces/new">) {
  const { orgSlug } = await params
  const result = await getWorkspaceCreation(orgSlug)
  if (result.error)
    return <RequestError title="Could not load workspace configuration" error={result.error} />
  if (result.scope.kind !== "ready") {
    return null
  }
  if (!result.candidates) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <>
      <RememberRoute />
      <WorkspaceForm
        candidates={result.candidates}
        orgSlug={result.scope.organization.slug}
        resources={result.resources}
      />
    </>
  )
}
