import { Suspense } from "react"
import { AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { SkillsClient } from "@/app/(app)/skills/skills-client"

export const unstable_instant = false

export default async function OrganizationSkillsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data) throw new Error("gateway returned no tenant resource capabilities")
  if (!tenant.data.skill_capabilities.read) return <AdministrationState kind="forbidden" />

  return (
    <Suspense fallback={null}>
      <SkillsClient
        agents={[]}
        canCreateImmutable={tenant.data.skill_capabilities.create}
        canReadImmutable={tenant.data.skill_capabilities.read}
      />
    </Suspense>
  )
}
