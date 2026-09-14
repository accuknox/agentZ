import { searchParamStringSchema } from "@/lib/search-params"
import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import InferenceProvidersPage from "@/app/(app)/inference/providers/provider-page"

export const metadata = { title: "Inference providers" }

export default function OrganizationInferenceProvidersPage(
  props: PageProps<"/orgs/[orgSlug]/inference/providers">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <OrganizationInferenceProvidersContent {...props} />
    </Suspense>
  )
}

async function OrganizationInferenceProvidersContent({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/inference/providers">) {
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
      pageToken={searchParamStringSchema.parse(page_token)}
      pageScope={{ kind: "organization", organizationName: scope.organization.name }}
      scope={{}}
    />
  )
}
