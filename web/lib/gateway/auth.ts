import "server-only"

import { headers } from "next/headers"
import { getAuth } from "@/lib/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export type GatewayAuthContext = {
  organizationId: string
  sessionId: string
  userId: string
}

type GatewayAuthState = GatewayAuthContext & {
  requestHeaders: Awaited<ReturnType<typeof headers>>
}

async function resolveGatewayAuthState(): Promise<GatewayAuthState> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })

  if (!session) {
    throw new GatewayUnauthorizedError()
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

  if (session.session.activeOrganizationId !== organizationId) {
    await auth.api.setActiveOrganization({
      body: {
        organizationId,
      },
      headers: requestHeaders,
    })
  }

  return {
    organizationId,
    requestHeaders,
    sessionId: session.session.id,
    userId: session.user.id,
  }
}

export async function currentGatewayAuthContext(): Promise<GatewayAuthContext> {
  const state = await resolveGatewayAuthState()
  return {
    organizationId: state.organizationId,
    sessionId: state.sessionId,
    userId: state.userId,
  }
}

export async function currentGatewayAuthToken(): Promise<string> {
  const state = await resolveGatewayAuthState()
  const auth = getAuth()
  const data = await auth.api.getToken({
    headers: state.requestHeaders,
  })

  return data.token
}
