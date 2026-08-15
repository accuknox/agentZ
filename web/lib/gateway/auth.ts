import "server-only"

import { and, eq, isNull, or } from "drizzle-orm"
import { getOrganizationSession } from "@/data/organizations"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export type GatewayAuthContext = {
  organizationId: string
  sessionId: string
  userId: string
  userName: string
}

type GatewayAgentAccess = {
  agent_name: string
  capabilities: (typeof schema.agentShareCapability.enumValues)[number][]
  owner: boolean
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
    userName: organizationSession.session.user.name,
  }
}

export async function currentGatewayAuthContext(): Promise<GatewayAuthContext> {
  const state = await resolveGatewayAuthState()
  return {
    organizationId: state.organizationId,
    sessionId: state.sessionId,
    userId: state.userId,
    userName: state.userName,
  }
}

/**
 * currentGatewayAuthToken signs identity and an authorization snapshot for the
 * selected scope. The gateway also resolves current grants on every request so
 * revocation remains immediate.
 */
export async function currentGatewayAuthToken(workspaceId?: string): Promise<string> {
  const state = await resolveGatewayAuthState()
  const db = getDB()
  const scopeType = workspaceId ? "workspace" : "organization"
  const scopeId = workspaceId ?? state.organizationId
  if (workspaceId) {
    const [workspace] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.organizationId, state.organizationId),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .limit(1)
    if (!workspace) {
      throw new GatewayUnauthorizedError()
    }
  }

  const directRoles = db
    .select({
      action: schema.permissionGrants.action,
      resource: schema.permissionGrants.resource,
      systemRole: schema.roleScopes.systemRole,
      workspaceId: schema.roleScopes.workspaceId,
    })
    .from(schema.members)
    .innerJoin(
      schema.memberRoles,
      and(
        eq(schema.memberRoles.memberId, schema.members.id),
        eq(schema.memberRoles.organizationId, schema.members.organizationId)
      )
    )
    .innerJoin(
      schema.roleScopes,
      and(
        eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
        eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
      )
    )
    .leftJoin(
      schema.permissionGrants,
      and(
        eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
        eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId),
        workspaceId
          ? eq(schema.permissionGrants.workspaceId, workspaceId)
          : isNull(schema.permissionGrants.workspaceId)
      )
    )
    .where(
      and(
        eq(schema.members.userId, state.userId),
        eq(schema.members.organizationId, state.organizationId),
        isNull(schema.members.disabledAt),
        workspaceId
          ? or(
              isNull(schema.roleScopes.workspaceId),
              eq(schema.roleScopes.workspaceId, workspaceId)
            )
          : isNull(schema.roleScopes.workspaceId)
      )
    )
  const teamGrants = db
    .select({ action: schema.permissionGrants.action, resource: schema.permissionGrants.resource })
    .from(schema.members)
    .innerJoin(schema.teamMembers, eq(schema.teamMembers.userId, schema.members.userId))
    .innerJoin(
      schema.teams,
      and(
        eq(schema.teams.id, schema.teamMembers.teamId),
        eq(schema.teams.organizationId, schema.members.organizationId)
      )
    )
    .innerJoin(
      schema.teamRoles,
      and(
        eq(schema.teamRoles.teamId, schema.teams.id),
        eq(schema.teamRoles.organizationId, schema.teams.organizationId)
      )
    )
    .innerJoin(
      schema.roleScopes,
      and(
        eq(schema.roleScopes.roleId, schema.teamRoles.roleId),
        eq(schema.roleScopes.organizationId, schema.teamRoles.organizationId),
        isNull(schema.roleScopes.systemRole)
      )
    )
    .innerJoin(
      schema.permissionGrants,
      and(
        eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
        eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId),
        workspaceId
          ? eq(schema.permissionGrants.workspaceId, workspaceId)
          : isNull(schema.permissionGrants.workspaceId)
      )
    )
    .where(
      and(
        eq(schema.members.userId, state.userId),
        eq(schema.members.organizationId, state.organizationId),
        isNull(schema.members.disabledAt),
        workspaceId
          ? or(
              isNull(schema.roleScopes.workspaceId),
              eq(schema.roleScopes.workspaceId, workspaceId)
            )
          : isNull(schema.roleScopes.workspaceId)
      )
    )

  const [assignedRoles, assignedTeamGrants] = await Promise.all([directRoles, teamGrants])
  const capabilities = new Set<string>()
  for (const grant of [...assignedRoles, ...assignedTeamGrants]) {
    if (grant.resource && grant.action) {
      capabilities.add(`${grant.resource}.${grant.action}`)
    }
  }
  const administrativeBypass = assignedRoles.some(
    (role) =>
      role.systemRole === "superadmin" ||
      (workspaceId && role.systemRole === "workspace_admin" && role.workspaceId === workspaceId)
  )

  const agentACL = new Map<string, GatewayAgentAccess>()
  if (workspaceId) {
    const [ownedAgents, directShares, teamShares] = await Promise.all([
      db
        .select({ agentName: schema.agentOwners.agentName })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, state.organizationId),
            eq(schema.agentOwners.workspaceId, workspaceId),
            eq(schema.agentOwners.ownerUserId, state.userId)
          )
        ),
      db
        .select({
          agentName: schema.agentShares.agentName,
          capability: schema.agentShareGrants.capability,
        })
        .from(schema.agentShares)
        .innerJoin(
          schema.agentShareGrants,
          eq(schema.agentShareGrants.shareId, schema.agentShares.id)
        )
        .where(
          and(
            eq(schema.agentShares.organizationId, state.organizationId),
            eq(schema.agentShares.workspaceId, workspaceId),
            eq(schema.agentShares.targetUserId, state.userId)
          )
        ),
      db
        .select({
          agentName: schema.agentShares.agentName,
          capability: schema.agentShareGrants.capability,
        })
        .from(schema.agentShares)
        .innerJoin(
          schema.agentShareGrants,
          eq(schema.agentShareGrants.shareId, schema.agentShares.id)
        )
        .innerJoin(
          schema.teamMembers,
          eq(schema.teamMembers.teamId, schema.agentShares.targetTeamId)
        )
        .innerJoin(
          schema.teams,
          and(
            eq(schema.teams.id, schema.teamMembers.teamId),
            eq(schema.teams.organizationId, schema.agentShares.organizationId)
          )
        )
        .where(
          and(
            eq(schema.agentShares.organizationId, state.organizationId),
            eq(schema.agentShares.workspaceId, workspaceId),
            eq(schema.teamMembers.userId, state.userId)
          )
        ),
    ])
    for (const { agentName } of ownedAgents) {
      agentACL.set(agentName, { agent_name: agentName, capabilities: [], owner: true })
    }
    for (const { agentName, capability } of [...directShares, ...teamShares]) {
      const access = agentACL.get(agentName) ?? {
        agent_name: agentName,
        capabilities: [],
        owner: false,
      }
      if (!access.capabilities.includes(capability)) {
        access.capabilities.push(capability)
      }
      agentACL.set(agentName, access)
    }
    for (const access of agentACL.values()) {
      access.capabilities.sort()
    }
  }

  const auth = getAuth()
  const data = await auth.api.signJWT({
    body: {
      payload: {
        administrative_bypass: administrativeBypass,
        agent_acl: [...agentACL.values()].sort((left, right) =>
          left.agent_name.localeCompare(right.agent_name)
        ),
        capabilities: [...capabilities].sort(),
        iat: Math.floor(Date.now() / 1000),
        organization_id: state.organizationId,
        scope_id: scopeId,
        scope_type: scopeType,
        sub: state.userId,
        user_id: state.userId,
        user_name: state.userName,
      },
    },
  })

  return data.token
}
