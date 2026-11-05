import { RememberRoute, missingRoute } from "@/data/route-memory"
import type { Metadata, Route } from "next"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"
import { RequestError } from "@/components/request-error"

export const metadata: Metadata = {
  title: "Setting up",
}

export default function OrganizationProvisioningPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-svh w-full items-center justify-center">
          <Shimmer className="text-center">Checking Organisation provisioning...</Shimmer>
        </main>
      }
    >
      <OrganizationProvisioning params={params} />
    </Suspense>
  )
}

async function OrganizationProvisioning({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind === "unauthorized") {
    redirect(signInURL({ returnTo: `/orgs/${orgSlug}/setting-up` }))
  }
  if (scope.kind !== "ready") {
    return missingRoute()
  }
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({
    client: getGatewayServerClient(),
  })
  if (tenant.error)
    return <RequestError title="Could not check organization setup" error={tenant.error} />
  if (tenant.data.ready) {
    redirect(`/orgs/${scope.organization.slug}` as Route)
  }

  return (
    <main className="flex min-h-svh w-full items-center justify-center">
      <RememberRoute />
      <meta httpEquiv="refresh" content="2" />
      <Shimmer className="text-center">We are provisioning this Organisation.</Shimmer>
    </main>
  )
}
