import "server-only"

import { getOrganizationSession } from "@/data/organizations"
import { getAuth } from "@/lib/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export type GatewayAuthContext = {
  organizationId: string
  sessionId: string
  userId: string
}

async function resolveGatewayAuthState(): Promise<GatewayAuthContext> {
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

/**
 * currentGatewayAuthToken signs identity and selected scope with Better Auth.
 * The gateway resolves current capabilities so revocation is immediate.
 */
export async function currentGatewayAuthToken(workspaceId?: string): Promise<string> {
  const state = await resolveGatewayAuthState()
  const auth = getAuth()
  const data = await auth.api.signJWT({
    body: {
      payload: {
        iat: Math.floor(Date.now() / 1000),
        sub: state.userId,
        tenant_id: state.organizationId,
        user_id: state.userId,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      },
    },
  })

  return data.token
}
