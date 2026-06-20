import "server-only"

import { headers } from "next/headers"
import { auth } from "@/lib/auth"

type GatewaySession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

export async function currentGatewayAuthToken(): Promise<string | undefined> {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    return
  }

  await ensureTenant(requestHeaders, session)

  const data = await auth.api.getToken({
    headers: requestHeaders,
  })

  return data.token
}

export async function ensureTenant(
  requestHeaders: Headers,
  session: GatewaySession
): Promise<string> {
  const activeOrganizationId = session.session.activeOrganizationId
  if (activeOrganizationId) {
    return activeOrganizationId
  }

  const organizations = await auth.api.listOrganizations({
    headers: requestHeaders,
  })

  if (organizations.length > 1) {
    throw new Error("gateway auth found multiple tenant organizations")
  }

  const organizationId = organizations[0]?.id
  if (!organizationId) {
    throw new Error("gateway auth found no tenant organization")
  }

  await auth.api.setActiveOrganization({
    body: {
      organizationId,
    },
    headers: requestHeaders,
  })

  return organizationId
}
