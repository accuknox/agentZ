import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { McpPage } from "@/app/(app)/mcps/mcp-page"

export const metadata = { title: "MCP connections" }

export default function OrganizationMcpPage(props: PageProps<"/orgs/[orgSlug]/mcps">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <OrganizationMcpContent {...props} />
    </Suspense>
  )
}

async function OrganizationMcpContent({ params, searchParams }: PageProps<"/orgs/[orgSlug]/mcps">) {
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
      pageScope={{ kind: "organization", organizationName: scope.organization.name }}
      searchParams={searchParams}
    />
  )
}
