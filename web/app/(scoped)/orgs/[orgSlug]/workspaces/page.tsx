import { AdministrationState } from "@/components/administration"
import { resolveOrganizationSlug } from "@/data/organizations"

export default async function WorkspacesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") {
    return null
  }

  if (!result.organization.superadmin) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <AdministrationState
      description="Create a Workspace to organise agents, access, and infrastructure inside this Organisation."
      kind="empty"
      title="No Workspaces yet"
    />
  )
}
