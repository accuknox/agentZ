import type { Route } from "next"
import { redirect } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { resolveOrganizationSlug } from "@/data/organizations"

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") {
    return null
  }

  if (result.organization.superadmin) {
    redirect(`/orgs/${result.organization.slug}/workspaces` as Route)
  }

  return (
    <AdministrationState
      description="You belong to this Organisation, but no Organisation resources are available to your role yet."
      kind="empty"
      title="No available resources"
    />
  )
}
