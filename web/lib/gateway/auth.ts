import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { loginURL } from "@/lib/login-redirect"

export async function currentGatewayAuthToken(returnTo?: string): Promise<string> {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    redirect(loginURL({ error: "session_expired", returnTo }))
  }

  const activeOrganizationId = session.session.activeOrganizationId
  if (!activeOrganizationId) {
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
  }

  const data = await auth.api.getToken({
    headers: requestHeaders,
  })

  return data.token
}
