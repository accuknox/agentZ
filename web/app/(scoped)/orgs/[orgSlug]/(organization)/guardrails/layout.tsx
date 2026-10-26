import { Suspense } from "react"
import { connection } from "next/server"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { GuardrailsLayout } from "@/app/(app)/guardrails/guardrails-layout"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export const metadata = { title: "Guardrails" }

export default function OrganizationGuardrailsLayout(
  props: LayoutProps<"/orgs/[orgSlug]/guardrails">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <OrganizationGuardrails {...props} />
    </Suspense>
  )
}

async function OrganizationGuardrails(props: LayoutProps<"/orgs/[orgSlug]/guardrails">) {
  const { params, children } = props

  await connection()
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(result.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data) return <AdministrationState kind="provisioning" />
  return (
    <GuardrailsLayout
      basePath={`/orgs/${orgSlug}/guardrails`}
      canAdminister={result.organization.superadmin}
      connectionCapabilities={tenant.data.guardrail_connection_capabilities}
      eventCapabilities={tenant.data.guardrail_event_capabilities}
      pageScope={{ kind: "organization", organizationName: result.organization.name }}
      policyCapabilities={tenant.data.guardrail_policy_capabilities}
    >
      {children}
    </GuardrailsLayout>
  )
}
