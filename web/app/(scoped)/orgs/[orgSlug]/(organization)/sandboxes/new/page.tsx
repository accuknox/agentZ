import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import NewSandboxPage from "@/app/(app)/sandboxes/new-sandbox-page"

export const metadata = { title: "New sandbox" }

export default function NewOrganizationSandboxPage(
  props: PageProps<"/orgs/[orgSlug]/sandboxes/new">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <NewOrganizationSandboxContent {...props} />
    </Suspense>
  )
}

async function NewOrganizationSandboxContent({
  params,
}: PageProps<"/orgs/[orgSlug]/sandboxes/new">) {
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
