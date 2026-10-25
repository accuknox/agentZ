import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import UpdateSandboxPage, { generateMetadata } from "@/app/(app)/sandboxes/update-sandbox-page"

export { generateMetadata }

export default function UpdateOrganizationSandboxPage(
  props: PageProps<"/orgs/[orgSlug]/sandboxes/update/[name]">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <UpdateOrganizationSandboxContent {...props} />
    </Suspense>
  )
}

async function UpdateOrganizationSandboxContent({
  params,
}: PageProps<"/orgs/[orgSlug]/sandboxes/update/[name]">) {
  const values = await params
  const scope = await resolveOrganizationSlug(values.orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data?.sandbox_capabilities.read) return <AdministrationState kind="forbidden" />
  return (
    <UpdateSandboxPage
      basePath={`/orgs/${scope.organization.slug}/sandboxes`}
      params={Promise.resolve({ name: values.name })}
      providersHref={{
        pathname: `/orgs/${scope.organization.slug}/inference/providers`,
      }}
    />
  )
}
