import { AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import SandboxesPage from "@/app/(app)/sandboxes/sandbox-page"

export const unstable_instant = false

export default async function OrganizationSandboxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  const { orgSlug } = await params
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") return <AdministrationState kind="forbidden" />
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({ client: getGatewayServerClient(), throwOnError: true })
  if (!tenant.data) throw new Error("gateway returned no tenant resource capabilities")
  if (!tenant.data.sandbox_capabilities.read) return <AdministrationState kind="forbidden" />

  return (
    <SandboxesPage
      basePath={`/orgs/${scope.organization.slug}/sandboxes`}
      capabilities={tenant.data.sandbox_capabilities}
      scopeLabel="Organisation"
      searchParams={searchParams}
    />
  )
}
