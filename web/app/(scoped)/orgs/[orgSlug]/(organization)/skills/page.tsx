import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { SkillsClient } from "@/app/(app)/skills/skills-client"

export const metadata = { title: "Skills" }

export default function OrganizationSkillsPage(props: PageProps<"/orgs/[orgSlug]/skills">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <OrganizationSkillsContent {...props} />
    </Suspense>
  )
}

async function OrganizationSkillsContent({ params }: PageProps<"/orgs/[orgSlug]/skills">) {
  const { orgSlug } = await params
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data) throw new Error("gateway returned no tenant resource capabilities")
  if (!tenant.data.skill_capabilities.read) return <AdministrationState kind="forbidden" />

  return (
    <SkillsClient
      agents={[]}
      canCreateImmutable={tenant.data.skill_capabilities.create}
      canReadImmutable={tenant.data.skill_capabilities.read}
      pageScope={{ kind: "organization", organizationName: scope.organization.name }}
    />
  )
}
