import { AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { McpPage } from "@/app/(app)/mcps/mcp-page"

export const unstable_instant = false

export default async function OrganizationMcpPage({
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
  if (!tenant.data.mcp_connection_capabilities.read) return <AdministrationState kind="forbidden" />
  const basePath = `/orgs/${orgSlug}/mcps`
  return (
    <McpPage
      basePath={basePath}
      canCreate={tenant.data.mcp_connection_capabilities.create}
      organizationId={scope.organization.id}
      searchParams={searchParams}
    />
  )
}
