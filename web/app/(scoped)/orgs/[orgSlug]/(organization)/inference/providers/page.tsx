import { AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import InferenceProvidersPage from "@/app/(app)/inference/providers/provider-page"

export default async function OrganizationInferenceProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const { orgSlug } = await params
  const { page_token } = await searchParams
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data?.inference_provider_capabilities.read)
    return <AdministrationState kind="forbidden" />
  return (
    <InferenceProvidersPage
      capabilities={tenant.data.inference_provider_capabilities}
      pageToken={page_token}
      scope={{}}
    />
  )
}
