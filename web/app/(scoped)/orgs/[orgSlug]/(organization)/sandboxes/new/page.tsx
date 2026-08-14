import { AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import NewSandboxPage from "@/app/(app)/sandboxes/new-sandbox-page"

export default async function NewOrganizationSandboxPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data?.sandbox_capabilities.create) return <AdministrationState kind="forbidden" />
  return (
    <NewSandboxPage
      basePath={`/orgs/${scope.organization.slug}/sandboxes`}
      providersHref={{
        pathname: `/orgs/${scope.organization.slug}/inference/providers`,
      }}
    />
  )
}
