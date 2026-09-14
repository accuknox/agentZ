import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { resolveOrganizationSlug } from "@/data/organizations"
import { OrganizationForm } from "./organization-form"

export const metadata = { title: "General" }

export default function GeneralPage(props: PageProps<"/orgs/[orgSlug]/general">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <GeneralContent {...props} />
    </Suspense>
  )
}

async function GeneralContent({ params }: PageProps<"/orgs/[orgSlug]/general">) {
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
