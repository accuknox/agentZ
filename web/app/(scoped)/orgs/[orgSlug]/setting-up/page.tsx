import type { Metadata, Route } from "next"
import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { ensureTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { signInURL } from "@/lib/sign-in-redirect"

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
          <Shimmer className="text-center">Checking Organisation provisioning…</Shimmer>
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
    notFound()
  }
  await activateOrganization(scope.organization.id)
  const tenant = await ensureTenant({
    client: getGatewayServerClient(),
    throwOnError: true,
  })
  if (!tenant.data) {
    throw new Error("gateway returned no organisation provisioning state")
  }
  if (tenant.data.ready) {
    redirect(`/orgs/${scope.organization.slug}` as Route)
  }

  return (
    <main className="flex min-h-svh w-full items-center justify-center">
      <meta httpEquiv="refresh" content="2" />
      <Shimmer className="text-center">We are provisioning this Organisation.</Shimmer>
    </main>
  )
}
