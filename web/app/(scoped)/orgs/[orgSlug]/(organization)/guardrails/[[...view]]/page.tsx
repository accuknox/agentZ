import { Suspense } from "react"
import { connection } from "next/server"
import { RememberRoute } from "@/data/route-memory"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { GuardrailsPage } from "@/app/(app)/guardrails/guardrails-page"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export default function OrganizationGuardrailsPage(
  props: PageProps<"/orgs/[orgSlug]/guardrails/[[...view]]">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <OrganizationGuardrails {...props} />
    </Suspense>
  )
}

async function OrganizationGuardrails(props: PageProps<"/orgs/[orgSlug]/guardrails/[[...view]]">) {
  const { params, searchParams } = props

  await connection()
  const { orgSlug, view } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(result.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data) return <AdministrationState kind="provisioning" />
  return (
    <>
      <RememberRoute />
      <GuardrailsPage
        basePath={`/orgs/${orgSlug}/guardrails`}
        canAdminister={result.organization.superadmin}
        connectionCapabilities={tenant.data.guardrail_connection_capabilities}
        eventCapabilities={tenant.data.guardrail_event_capabilities}
        policyCapabilities={tenant.data.guardrail_policy_capabilities}
        searchParams={await searchParams}
        view={view ?? []}
      />
    </>
  )
}
