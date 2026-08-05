import "server-only"

import { getOrganizationSession } from "@/data/organizations"
import { getAuth } from "@/lib/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export type GatewayAuthContext = {
  organizationId: string
  sessionId: string
  userId: string
}

type GatewayAuthState = GatewayAuthContext & {
  requestHeaders: Headers
}

async function resolveGatewayAuthState(): Promise<GatewayAuthState> {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    throw new GatewayUnauthorizedError()
  }

  const organization = organizationSession.organizations.find(
    (candidate) => candidate.id === organizationSession.session.session.activeOrganizationId
  )
  if (!organization) {
    throw new GatewayUnauthorizedError()
  }

  return {
    organizationId: organization.id,
    requestHeaders: organizationSession.requestHeaders,
    sessionId: organizationSession.session.session.id,
    userId: organizationSession.session.user.id,
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
