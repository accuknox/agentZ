import { AdministrationState } from "@/components/administration"
import { resolveOrganizationSlug } from "@/data/organizations"
import { OrganizationForm } from "./organization-form"

export const metadata = { title: "General" }

export default async function GeneralPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") {
    return null
  }

  if (!result.organization.superadmin) {
    return <AdministrationState kind="forbidden" />
  }

  return <OrganizationForm organization={result.organization} />
}
