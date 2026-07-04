import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { getAuth } from "@/lib/auth"
import { ensureTenant } from "@/lib/gateway/client/sdk.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { BootstrappingStatus } from "./status"

export const metadata: Metadata = {
  title: "Setting up",
}

export default function BootstrappingPage() {
  return (
    <Suspense fallback={<BootstrappingPlaceholder />}>
      <BootstrappingGate />
    </Suspense>
  )
}

function BootstrappingPlaceholder() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center">
      <Shimmer className="text-center">We&apos;re getting everything ready for you.</Shimmer>
    </main>
  )
}

async function BootstrappingGate() {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    redirect("/signin")
  }

  const tenant = await ensureTenant({
    client: getGatewayServerClient(),
    throwOnError: true,
  })
  const tenantData = tenant.data

  if (!tenantData) {
    throw new Error("gateway returned no tenant bootstrap state")
  }

  if (tenantData.ready) {
    redirect("/")
  }

  return (
    <main className="flex min-h-svh w-full items-center justify-center">
      <BootstrappingStatus initialTenant={tenantData} />
    </main>
  )
}
