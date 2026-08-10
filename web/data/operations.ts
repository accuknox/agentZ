import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import { and, asc, desc, eq, exists, inArray, isNull, ne, or } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"
import { getAuth } from "@/lib/auth"

export type DestructiveTarget =
  | {
      operation: "membership_disable" | "membership_remove"
      targetId: string
      targetType: "organization_membership"
    }
  | { operation: "team_delete"; targetId: string; targetType: "team" }
  | { operation: "role_reduce"; targetId: string; targetType: "role" }
  | { operation: "access_revoke"; targetId: string; targetType: "workspace_access" }
  | { operation: "workspace_delete"; targetId: string; targetType: "workspace" }

export type DestructiveImpactItem = {
  id: string
  detail: string
  group:
    | "Access loss"
    | "Roles"
    | "Owned Agents"
    | "Agent shares"
    | "API keys"
    | "Consumers"
    | "External cleanup"
  href?: string
  label: string
  severity: "critical" | "warning" | "info"
}

export type DestructiveImpact = {
  confirmation: string
  fingerprint: string
  items: DestructiveImpactItem[]
  target: DestructiveTarget
  targetLabel: string
}

export type CleanupRow = {
  id: string
  operation: string
  targetType: string
  targetId: string
  state: "pending" | "running" | "retrying" | "failed" | "succeeded"
  impact: string[]
  attempts: number
  scheduledAt: string | null
  lastError: string | null
  createdAt: string
  completedAt: string | null
}

type ImpactDatabase = Pick<ReturnType<typeof getDB>, "select">

export type WorkspaceAccessLoss = {
  memberId: string
  userId: string
  name: string
  email: string
  workspaceId: string
  workspace: string
  workspaceSlug: string
}

export type CascadingAgent = {
  agentName: string
  ownerUserId: string
  workspaceId: string
  workspace: string
  workspaceSlug: string
}

export type AffectedAPIKey = {
  id: string
  name: string
  workspaceId: string
  workspace: string
  workspaceSlug: string
}

export async function findWorkspaceAccessLosses(
  db: ImpactDatabase,
  organizationId: string,
  candidates: WorkspaceAccessLoss[],
  excluded: { roleId?: string; teamId?: string }
) {
  const userIds = [...new Set(candidates.map(({ userId }) => userId))]
  if (!userIds.length) return []
  const [superadmins, directScopes, directGrants, teamScopes, teamGrants] = await Promise.all([
    db
      .select({ userId: schema.members.userId })
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
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          inArray(schema.members.userId, userIds),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "superadmin"),
          excluded.roleId ? ne(schema.memberRoles.roleId, excluded.roleId) : undefined
        )
      ),
    db
      .select({ userId: schema.members.userId, workspaceId: schema.roleScopes.workspaceId })
      .from(schema.members)
      .innerJoin(schema.memberRoles, eq(schema.memberRoles.memberId, schema.members.id))
      .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.memberRoles.roleId))
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.memberRoles.organizationId, organizationId),
          eq(schema.roleScopes.organizationId, organizationId),
          inArray(schema.members.userId, userIds),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "workspace_admin"),
          excluded.roleId ? ne(schema.memberRoles.roleId, excluded.roleId) : undefined
        )
      ),
    db
      .select({ userId: schema.members.userId, workspaceId: schema.permissionGrants.workspaceId })
      .from(schema.members)
      .innerJoin(schema.memberRoles, eq(schema.memberRoles.memberId, schema.members.id))
      .innerJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.memberRoles.roleId),
          eq(schema.permissionGrants.organizationId, schema.memberRoles.organizationId)
        )
      )
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.memberRoles.organizationId, organizationId),
          inArray(schema.members.userId, userIds),
          isNull(schema.members.disabledAt),
          excluded.roleId ? ne(schema.memberRoles.roleId, excluded.roleId) : undefined
        )
      ),
    db
      .select({ userId: schema.members.userId, workspaceId: schema.roleScopes.workspaceId })
      .from(schema.members)
      .innerJoin(schema.teamMembers, eq(schema.teamMembers.userId, schema.members.userId))
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .innerJoin(schema.teamRoles, eq(schema.teamRoles.teamId, schema.teams.id))
      .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.teamRoles.roleId))
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.teams.organizationId, organizationId),
          eq(schema.teamRoles.organizationId, organizationId),
          eq(schema.roleScopes.organizationId, organizationId),
          inArray(schema.members.userId, userIds),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "workspace_admin"),
          excluded.teamId ? ne(schema.teams.id, excluded.teamId) : undefined,
          excluded.roleId ? ne(schema.teamRoles.roleId, excluded.roleId) : undefined
        )
      ),
    db
      .select({ userId: schema.members.userId, workspaceId: schema.permissionGrants.workspaceId })
      .from(schema.members)
      .innerJoin(schema.teamMembers, eq(schema.teamMembers.userId, schema.members.userId))
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .innerJoin(schema.teamRoles, eq(schema.teamRoles.teamId, schema.teams.id))
      .innerJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
          eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId)
        )
      )
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.teams.organizationId, organizationId),
          eq(schema.teamRoles.organizationId, organizationId),
          inArray(schema.members.userId, userIds),
          isNull(schema.members.disabledAt),
          excluded.teamId ? ne(schema.teams.id, excluded.teamId) : undefined,
          excluded.roleId ? ne(schema.teamRoles.roleId, excluded.roleId) : undefined
        )
      ),
  ])
  const administrators = new Set(superadmins.map(({ userId }) => userId))
  const access = new Set(
    [...directScopes, ...directGrants, ...teamScopes, ...teamGrants].flatMap(
      ({ userId, workspaceId }) => (workspaceId ? [`${userId}:${workspaceId}`] : [])
    )
  )
  return candidates.filter(
    ({ userId, workspaceId }) =>
      !administrators.has(userId) && !access.has(`${userId}:${workspaceId}`)
  )
}

export async function findCascadingAgents(
  db: ImpactDatabase,
  organizationId: string,
  losses: WorkspaceAccessLoss[]
) {
  const userIds = [...new Set(losses.map(({ userId }) => userId))]
  const workspaceIds = [...new Set(losses.map(({ workspaceId }) => workspaceId))]
  if (!userIds.length || !workspaceIds.length) return []
  const pairs = new Set(losses.map(({ userId, workspaceId }) => `${userId}:${workspaceId}`))
  const agents = await db
    .select({
      agentName: schema.agentOwners.agentName,
      ownerUserId: schema.agentOwners.ownerUserId,
      workspaceId: schema.agentOwners.workspaceId,
      workspace: schema.workspaces.name,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.agentOwners)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.agentOwners.workspaceId))
    .where(
      and(
        eq(schema.agentOwners.organizationId, organizationId),
        inArray(schema.agentOwners.ownerUserId, userIds),
        inArray(schema.agentOwners.workspaceId, workspaceIds)
      )
    )
    .orderBy(asc(schema.workspaces.name), asc(schema.agentOwners.agentName))
  return agents.filter(({ ownerUserId, workspaceId }) => pairs.has(`${ownerUserId}:${workspaceId}`))
}

export async function findAffectedAPIKeys(
  db: ImpactDatabase,
  organizationId: string,
  losses: WorkspaceAccessLoss[],
  agents: CascadingAgent[]
) {
  const workspaceIds = [
    ...new Set([
      ...losses.map(({ workspaceId }) => workspaceId),
      ...agents.map(({ workspaceId }) => workspaceId),
    ]),
  ]
  if (!workspaceIds.length) return []
  const lossPairs = new Set(losses.map(({ userId, workspaceId }) => `${userId}:${workspaceId}`))
  const agentPairs = new Set(
    agents.map(({ agentName, workspaceId }) => `${workspaceId}:${agentName}`)
  )
  const rows = await db
    .select({
      creatorUserId: schema.apiKeyScopes.creatorUserId,
      id: schema.apiKeyScopes.apiKeyId,
      name: schema.apikeys.name,
      targetAgentName: schema.apiKeyTargets.agentName,
      workspaceId: schema.apiKeyScopes.workspaceId,
      workspace: schema.workspaces.name,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.apiKeyScopes)
    .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
    .innerJoin(
      schema.apiKeyTargets,
      eq(schema.apiKeyTargets.apiKeyId, schema.apiKeyScopes.apiKeyId)
    )
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.apiKeyScopes.workspaceId))
    .where(
      and(
        eq(schema.apiKeyScopes.organizationId, organizationId),
        inArray(schema.apiKeyScopes.workspaceId, workspaceIds),
        isNull(schema.apiKeyScopes.revokedAt)
      )
    )
    .orderBy(asc(schema.apikeys.name), asc(schema.apiKeyScopes.apiKeyId))
  const keys = new Map<string, AffectedAPIKey>()
  for (const row of rows) {
    if (
      !lossPairs.has(`${row.creatorUserId}:${row.workspaceId}`) &&
      !agentPairs.has(`${row.workspaceId}:${row.targetAgentName}`)
    ) {
      continue
    }
    keys.set(row.id, row)
  }
  return [...keys.values()]
}

export async function analyzeTeamDeletionEffects(
  db: ImpactDatabase,
  organizationId: string,
  teamId: string
) {
  const [team] = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(and(eq(schema.teams.id, teamId), eq(schema.teams.organizationId, organizationId)))
    .limit(1)
  if (!team) return
  const [members, roles, shares, invitations, socialDefaults, scopedAccess, grantedAccess] =
    await Promise.all([
      db
        .select({
          email: schema.users.email,
          memberId: schema.members.id,
          name: schema.users.name,
          userId: schema.members.userId,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            eq(schema.members.organizationId, organizationId),
            isNull(schema.members.disabledAt)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email)),
      db
        .select({
          id: schema.roleScopes.roleId,
          name: schema.roleScopes.displayName,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.teamRoles)
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.teamRoles.roleId))
        .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.roleScopes.workspaceId))
        .where(
          and(
            eq(schema.teamRoles.teamId, teamId),
            eq(schema.teamRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.roleScopes.displayName)),
      db
        .select({
          id: schema.agentShares.id,
          name: schema.agentShares.agentName,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.agentShares)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.agentShares.workspaceId))
        .where(
          and(
            eq(schema.agentShares.organizationId, organizationId),
            eq(schema.agentShares.targetTeamId, teamId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.agentShares.agentName)),
      db
        .select({ id: schema.invitations.id, email: schema.invitations.email })
        .from(schema.invitationTeams)
        .innerJoin(
          schema.invitations,
          eq(schema.invitations.id, schema.invitationTeams.invitationId)
        )
        .where(
          and(
            eq(schema.invitationTeams.organizationId, organizationId),
            eq(schema.invitationTeams.teamId, teamId),
            eq(schema.invitations.organizationId, organizationId),
            eq(schema.invitations.status, "pending")
          )
        )
        .orderBy(asc(schema.invitations.email), asc(schema.invitations.id)),
      db
        .select({ teamId: schema.socialAdmissionDefaultTeams.teamId })
        .from(schema.socialAdmissionDefaultTeams)
        .where(
          and(
            eq(schema.socialAdmissionDefaultTeams.organizationId, organizationId),
            eq(schema.socialAdmissionDefaultTeams.teamId, teamId)
          )
        ),
      db
        .select({
          email: schema.users.email,
          memberId: schema.members.id,
          name: schema.users.name,
          userId: schema.members.userId,
          workspaceId: schema.roleScopes.workspaceId,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .innerJoin(schema.teamRoles, eq(schema.teamRoles.teamId, schema.teamMembers.teamId))
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.teamRoles.roleId))
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.roleScopes.workspaceId))
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            eq(schema.members.organizationId, organizationId),
            eq(schema.teamRoles.organizationId, organizationId),
            eq(schema.roleScopes.systemRole, "workspace_admin"),
            isNull(schema.members.disabledAt),
            isNull(schema.workspaces.deletedAt)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email), asc(schema.workspaces.name)),
      db
        .select({
          email: schema.users.email,
          memberId: schema.members.id,
          name: schema.users.name,
          userId: schema.members.userId,
          workspaceId: schema.permissionGrants.workspaceId,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .innerJoin(schema.teamRoles, eq(schema.teamRoles.teamId, schema.teamMembers.teamId))
        .innerJoin(
          schema.permissionGrants,
          eq(schema.permissionGrants.roleId, schema.teamRoles.roleId)
        )
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.permissionGrants.workspaceId))
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            eq(schema.members.organizationId, organizationId),
            eq(schema.teamRoles.organizationId, organizationId),
            eq(schema.permissionGrants.organizationId, organizationId),
            isNull(schema.members.disabledAt),
            isNull(schema.workspaces.deletedAt)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email), asc(schema.workspaces.name)),
    ])
  const candidates = new Map<string, WorkspaceAccessLoss>()
  for (const row of [...scopedAccess, ...grantedAccess]) {
    if (!row.workspaceId) continue
    candidates.set(`${row.userId}:${row.workspaceId}`, { ...row, workspaceId: row.workspaceId })
  }
  const losses = await findWorkspaceAccessLosses(db, organizationId, [...candidates.values()], {
    teamId,
  })
  const agents = await findCascadingAgents(db, organizationId, losses)
  const keys = await findAffectedAPIKeys(db, organizationId, losses, agents)
  return { agents, invitations, keys, losses, members, roles, shares, socialDefaults, team }
}

export async function analyzeRoleReductionEffects(
  db: ImpactDatabase,
  organizationId: string,
  roleId: string,
  workspaceIds: string[]
) {
  const [members, teamMembers] = await Promise.all([
    db
      .select({
        email: schema.users.email,
        memberId: schema.members.id,
        name: schema.users.name,
        userId: schema.members.userId,
      })
      .from(schema.memberRoles)
      .innerJoin(schema.members, eq(schema.members.id, schema.memberRoles.memberId))
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.memberRoles.organizationId, organizationId),
          eq(schema.memberRoles.roleId, roleId),
          isNull(schema.members.disabledAt)
        )
      )
      .orderBy(asc(schema.users.name), asc(schema.users.email)),
    db
      .select({
        email: schema.users.email,
        memberId: schema.members.id,
        name: schema.users.name,
        userId: schema.members.userId,
      })
      .from(schema.teamRoles)
      .innerJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teamRoles.teamId))
      .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.teamRoles.organizationId, organizationId),
          eq(schema.teamRoles.roleId, roleId),
          isNull(schema.members.disabledAt)
        )
      )
      .orderBy(asc(schema.users.name), asc(schema.users.email)),
  ])
  const users = new Map([...members, ...teamMembers].map((member) => [member.userId, member]))
  const memberIds = [...new Set([...members, ...teamMembers].map(({ memberId }) => memberId))]
  if (!workspaceIds.length) return { agents: [], keys: [], losses: [], memberIds }
  const workspaces = await db
    .select({
      workspaceId: schema.workspaces.id,
      workspace: schema.workspaces.name,
      workspaceSlug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.organizationId, organizationId),
        inArray(schema.workspaces.id, workspaceIds),
        isNull(schema.workspaces.deletedAt)
      )
    )
    .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.slug))
  const candidates = [...users.values()].flatMap((member) =>
    workspaces.map((workspace) => ({ ...member, ...workspace }))
  )
  const losses = await findWorkspaceAccessLosses(db, organizationId, candidates, { roleId })
  const agents = await findCascadingAgents(db, organizationId, losses)
  const keys = await findAffectedAPIKeys(db, organizationId, losses, agents)
  return { agents, keys, losses, memberIds }
}

export async function analyzeDestructiveImpact(
  db: ImpactDatabase,
  organizationId: string,
  orgSlug: string,
  target: DestructiveTarget
): Promise<DestructiveImpact | null> {
  const items: DestructiveImpactItem[] = []
  let targetLabel: string

  if (target.operation === "membership_disable" || target.operation === "membership_remove") {
    const [member] = await db
      .select({
        email: schema.users.email,
        name: schema.users.name,
        userId: schema.members.userId,
      })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.members.organizationId, organizationId),
          eq(schema.members.id, target.targetId)
        )
      )
      .limit(1)
    if (!member) return null
    targetLabel = member.name

    const [roles, roleGrants, teams, teamRoles, teamGrants, workspaces, agents, keys, shares] =
      await Promise.all([
        db
          .select({
            id: schema.roleScopes.roleId,
            name: schema.roleScopes.displayName,
            systemRole: schema.roleScopes.systemRole,
            workspaceId: schema.roleScopes.workspaceId,
            workspace: schema.workspaces.name,
            workspaceSlug: schema.workspaces.slug,
          })
          .from(schema.memberRoles)
          .innerJoin(
            schema.roleScopes,
            and(
              eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
              eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
            )
          )
          .leftJoin(
            schema.workspaces,
            and(
              eq(schema.workspaces.id, schema.roleScopes.workspaceId),
              eq(schema.workspaces.organizationId, schema.roleScopes.organizationId)
            )
          )
          .where(
            and(
              eq(schema.memberRoles.organizationId, organizationId),
              eq(schema.memberRoles.memberId, target.targetId)
            )
          )
          .orderBy(asc(schema.roleScopes.displayName)),
        db
          .selectDistinct({ workspaceId: schema.permissionGrants.workspaceId })
          .from(schema.memberRoles)
          .innerJoin(
            schema.permissionGrants,
            and(
              eq(schema.permissionGrants.roleId, schema.memberRoles.roleId),
              eq(schema.permissionGrants.organizationId, schema.memberRoles.organizationId)
            )
          )
          .where(
            and(
              eq(schema.memberRoles.organizationId, organizationId),
              eq(schema.memberRoles.memberId, target.targetId)
            )
          ),
        db
          .select({ id: schema.teams.id, name: schema.teams.name })
          .from(schema.teamMembers)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
          .where(
            and(
              eq(schema.teams.organizationId, organizationId),
              eq(schema.teamMembers.userId, member.userId)
            )
          )
          .orderBy(asc(schema.teams.name)),
        db
          .selectDistinct({ workspaceId: schema.roleScopes.workspaceId })
          .from(schema.teamMembers)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
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
              eq(schema.roleScopes.organizationId, schema.teamRoles.organizationId)
            )
          )
          .where(
            and(
              eq(schema.teams.organizationId, organizationId),
              eq(schema.teamMembers.userId, member.userId),
              eq(schema.roleScopes.systemRole, "workspace_admin")
            )
          ),
        db
          .selectDistinct({ workspaceId: schema.permissionGrants.workspaceId })
          .from(schema.teamMembers)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
          .innerJoin(
            schema.teamRoles,
            and(
              eq(schema.teamRoles.teamId, schema.teams.id),
              eq(schema.teamRoles.organizationId, schema.teams.organizationId)
            )
          )
          .innerJoin(
            schema.permissionGrants,
            and(
              eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
              eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId)
            )
          )
          .where(
            and(
              eq(schema.teams.organizationId, organizationId),
              eq(schema.teamMembers.userId, member.userId)
            )
          ),
        db
          .select({
            id: schema.workspaces.id,
            name: schema.workspaces.name,
            slug: schema.workspaces.slug,
          })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.organizationId, organizationId),
              isNull(schema.workspaces.deletedAt)
            )
          )
          .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.slug)),
        db
          .select({
            name: schema.agentOwners.agentName,
            workspaceId: schema.workspaces.id,
            workspace: schema.workspaces.name,
            workspaceSlug: schema.workspaces.slug,
          })
          .from(schema.agentOwners)
          .innerJoin(
            schema.workspaces,
            and(
              eq(schema.workspaces.id, schema.agentOwners.workspaceId),
              eq(schema.workspaces.organizationId, schema.agentOwners.organizationId)
            )
          )
          .where(
            and(
              eq(schema.agentOwners.organizationId, organizationId),
              eq(schema.agentOwners.ownerUserId, member.userId)
            )
          )
          .orderBy(asc(schema.workspaces.name), asc(schema.agentOwners.agentName)),
        db
          .selectDistinct({
            id: schema.apiKeyScopes.apiKeyId,
            name: schema.apikeys.name,
            workspaceId: schema.workspaces.id,
            workspace: schema.workspaces.name,
            workspaceSlug: schema.workspaces.slug,
          })
          .from(schema.apiKeyScopes)
          .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
          .innerJoin(
            schema.apiKeyTargets,
            eq(schema.apiKeyTargets.apiKeyId, schema.apiKeyScopes.apiKeyId)
          )
          .innerJoin(
            schema.workspaces,
            and(
              eq(schema.workspaces.id, schema.apiKeyScopes.workspaceId),
              eq(schema.workspaces.organizationId, schema.apiKeyScopes.organizationId)
            )
          )
          .where(
            and(
              eq(schema.apiKeyScopes.organizationId, organizationId),
              isNull(schema.apiKeyScopes.revokedAt),
              or(
                eq(schema.apiKeyScopes.creatorUserId, member.userId),
                exists(
                  db
                    .select({ ownerUserId: schema.agentOwners.ownerUserId })
                    .from(schema.agentOwners)
                    .where(
                      and(
                        eq(schema.agentOwners.organizationId, organizationId),
                        eq(schema.agentOwners.ownerUserId, member.userId),
                        eq(schema.agentOwners.workspaceId, schema.apiKeyScopes.workspaceId),
                        eq(schema.agentOwners.agentName, schema.apiKeyTargets.agentName)
                      )
                    )
                )
              )
            )
          )
          .orderBy(asc(schema.apikeys.name), asc(schema.apiKeyScopes.apiKeyId)),
        db
          .select({
            id: schema.agentShares.id,
            name: schema.agentShares.agentName,
            workspaceId: schema.workspaces.id,
            workspace: schema.workspaces.name,
            workspaceSlug: schema.workspaces.slug,
          })
          .from(schema.agentShares)
          .innerJoin(
            schema.workspaces,
            and(
              eq(schema.workspaces.id, schema.agentShares.workspaceId),
              eq(schema.workspaces.organizationId, schema.agentShares.organizationId)
            )
          )
          .where(
            and(
              eq(schema.agentShares.organizationId, organizationId),
              eq(schema.agentShares.targetUserId, member.userId)
            )
          )
          .orderBy(asc(schema.workspaces.name), asc(schema.agentShares.agentName)),
      ])
    const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    const affectedWorkspaces = new Map<string, { id: string; name: string; slug: string }>()
    if (roles.some((role) => role.systemRole === "superadmin")) {
      for (const workspace of workspaces) affectedWorkspaces.set(workspace.id, workspace)
    }
    for (const role of roles) {
      if (role.systemRole !== "workspace_admin" || !role.workspaceId) continue
      const workspace = workspacesById.get(role.workspaceId)
      if (workspace) affectedWorkspaces.set(workspace.id, workspace)
    }
    for (const role of [...roleGrants, ...teamRoles, ...teamGrants]) {
      if (!role.workspaceId) continue
      const workspace = workspacesById.get(role.workspaceId)
      if (workspace) affectedWorkspaces.set(workspace.id, workspace)
    }
    for (const workspace of [...agents, ...keys, ...shares]) {
      affectedWorkspaces.set(workspace.workspaceId, {
        id: workspace.workspaceId,
        name: workspace.workspace,
        slug: workspace.workspaceSlug,
      })
    }
    items.push(
      ...affectedWorkspaces.values().map((workspace) => ({
        detail: "All effective Membership access in this Workspace is removed.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}`,
        id: `workspace:${workspace.id}`,
        label: workspace.name,
        severity: "critical" as const,
      })),
      ...roles.map((role) => ({
        detail: `${role.workspace ?? "Organisation"} scope; the direct Role assignment is removed from the effective permission union.`,
        group: "Access loss" as const,
        href: role.workspaceSlug
          ? `/orgs/${orgSlug}/workspaces/${role.workspaceSlug}/roles/${role.id}`
          : `/orgs/${orgSlug}/roles/${role.id}`,
        id: `role:${role.id}`,
        label: role.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Team-derived Roles and Agent Shares stop contributing access.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...shares.map((share) => ({
        detail: `Direct Agent Share in ${share.workspace} is revoked.`,
        group: "Access loss" as const,
        id: `share:${share.id}`,
        label: share.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail: `${agent.workspace}; Kubernetes and secret resources are queued for cleanup.`,
        group: "Owned Agents" as const,
        href: `/orgs/${orgSlug}/workspaces/${agent.workspaceSlug}/agents/${encodeURIComponent(agent.name)}/ownership`,
        id: `agent:${agent.workspaceSlug}:${agent.name}`,
        label: agent.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail:
          "Workflow schedules and runs, mutable Skills, secrets, shares, sessions, and telemetry are removed with the Agent.",
        group: "Consumers" as const,
        id: `agent-resources:${agent.workspaceSlug}:${agent.name}`,
        label: `${agent.name} bound resources`,
        severity: "warning" as const,
      })),
      ...keys.map((key) => ({
        detail: `${key.workspace}; the credential is revoked in the same transaction as access removal.`,
        group: "API keys" as const,
        href: `/orgs/${orgSlug}/workspaces/${key.workspaceSlug}/api-keys`,
        id: `key:${key.id}`,
        label: key.name,
        severity: "critical" as const,
      }))
    )
    if (agents.length) {
      items.push({
        detail: "Missing objects are treated as complete; temporary failures are retried durably.",
        group: "External cleanup",
        id: "external:member-agents",
        label: "Kubernetes and OpenBao Agent resources",
        severity: "warning",
      })
    }
  } else if (target.operation === "team_delete") {
    const effects = await analyzeTeamDeletionEffects(db, organizationId, target.targetId)
    if (!effects) return null
    targetLabel = effects.team.name
    items.push(
      ...effects.members.map((member) => ({
        detail: `${member.email}; every Team-derived permission is removed.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.memberId}`,
        id: `member:${member.memberId}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...effects.losses.map((loss) => ({
        detail: `${loss.name} loses their final role-derived access path.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${loss.memberId}?scope=${loss.workspaceId}`,
        id: `workspace-loss:${loss.userId}:${loss.workspaceId}`,
        label: loss.workspace,
        severity: "critical" as const,
      })),
      ...effects.roles.map((role) => ({
        detail: `${role.workspace ?? "Organisation"} Team Role assignment is detached.`,
        group: "Access loss" as const,
        href: role.workspaceSlug
          ? `/orgs/${orgSlug}/workspaces/${role.workspaceSlug}/roles/${role.id}/permissions`
          : `/orgs/${orgSlug}/roles/${role.id}/permissions`,
        id: `role:${role.id}`,
        label: role.name,
        severity: "warning" as const,
      })),
      ...effects.shares.map((share) => ({
        detail: `Team Agent Share in ${share.workspace} is revoked.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/workspaces/${share.workspaceSlug}/agents/${encodeURIComponent(share.name)}/sharing`,
        id: `share:${share.id}`,
        label: share.name,
        severity: "critical" as const,
      })),
      ...effects.agents.map((agent) => ({
        detail: `${agent.workspace}; transfer ownership before confirming to preserve this Agent.`,
        group: "Owned Agents" as const,
        href: `/orgs/${orgSlug}/workspaces/${agent.workspaceSlug}/agents/${encodeURIComponent(agent.agentName)}/ownership`,
        id: `agent:${agent.workspaceId}:${agent.agentName}`,
        label: agent.agentName,
        severity: "critical" as const,
      })),
      ...effects.keys.map((key) => ({
        detail: `${key.workspace}; creator access or a selected Agent target is removed.`,
        group: "API keys" as const,
        href: `/orgs/${orgSlug}/workspaces/${key.workspaceSlug}/api-keys`,
        id: `key:${key.id}`,
        label: key.name,
        severity: "critical" as const,
      })),
      ...effects.invitations.map((invitation) => ({
        detail: `${invitation.email}; the pending Invitation no longer assigns this Team.`,
        group: "Consumers" as const,
        href: `/orgs/${orgSlug}/users/invited`,
        id: `invitation:${invitation.id}`,
        label: invitation.email,
        severity: "warning" as const,
      })),
      ...effects.socialDefaults.map(() => ({
        detail: "New social admissions no longer receive this Team.",
        group: "Consumers" as const,
        href: `/orgs/${orgSlug}/social-admission`,
        id: "social-default",
        label: "Social Admission default",
        severity: "warning" as const,
      }))
    )
  } else if (target.operation === "role_reduce") {
    const [role] = await db
      .select({ name: schema.roleScopes.displayName })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.roleId, target.targetId),
          eq(schema.roleScopes.organizationId, organizationId)
        )
      )
      .limit(1)
    if (!role) return null
    targetLabel = role.name
    const [members, teams, grants] = await Promise.all([
      db
        .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
        .from(schema.memberRoles)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberRoles.memberId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .where(
          and(
            eq(schema.memberRoles.roleId, target.targetId),
            eq(schema.memberRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email))
        .limit(500),
      db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamRoles)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamRoles.teamId))
        .where(
          and(
            eq(schema.teamRoles.roleId, target.targetId),
            eq(schema.teamRoles.organizationId, organizationId)
          )
        )
        .orderBy(asc(schema.teams.name))
        .limit(500),
      db
        .select({
          action: schema.permissionGrants.action,
          resource: schema.permissionGrants.resource,
          workspace: schema.workspaces.name,
        })
        .from(schema.permissionGrants)
        .leftJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.permissionGrants.workspaceId),
            eq(schema.workspaces.organizationId, schema.permissionGrants.organizationId)
          )
        )
        .where(
          and(
            eq(schema.permissionGrants.roleId, target.targetId),
            eq(schema.permissionGrants.organizationId, organizationId)
          )
        )
        .orderBy(
          asc(schema.workspaces.name),
          asc(schema.permissionGrants.resource),
          asc(schema.permissionGrants.action)
        )
        .limit(500),
    ])
    items.push(
      ...members.map((member) => ({
        detail: `${member.email}; other direct and Team Roles may preserve access.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.id}`,
        id: `member:${member.id}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Every active Team member loses this Role source.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}/roles`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...grants.map((grant) => ({
        detail: grant.workspace ?? "Organisation",
        group: "Consumers" as const,
        id: `grant:${grant.workspace ?? "org"}:${grant.resource}:${grant.action}`,
        label: `${grant.resource}.${grant.action}`,
        severity: "warning" as const,
      }))
    )
  } else {
    const [workspace] = await db
      .select({
        name: schema.workspaces.name,
        namespace: schema.workspaces.namespace,
        slug: schema.workspaces.slug,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, target.targetId),
          eq(schema.workspaces.organizationId, organizationId),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .limit(1)
    if (!workspace) return null
    targetLabel = workspace.name
    const [members, teams, roles, agents, shares, keys, consumers] = await Promise.all([
      db
        .selectDistinct({
          id: schema.members.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.memberRoles)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberRoles.memberId))
        .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.memberRoles.roleId))
        .leftJoin(
          schema.permissionGrants,
          and(
            eq(schema.permissionGrants.roleId, schema.memberRoles.roleId),
            eq(schema.permissionGrants.organizationId, schema.memberRoles.organizationId)
          )
        )
        .where(
          and(
            eq(schema.memberRoles.organizationId, organizationId),
            eq(schema.roleScopes.organizationId, organizationId),
            isNull(schema.members.disabledAt),
            or(
              eq(schema.roleScopes.systemRole, "superadmin"),
              eq(schema.roleScopes.workspaceId, target.targetId),
              eq(schema.permissionGrants.workspaceId, target.targetId)
            )
          )
        )
        .orderBy(asc(schema.users.name), asc(schema.users.email)),
      db
        .selectDistinct({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamRoles)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamRoles.teamId))
        .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.teamRoles.roleId))
        .leftJoin(
          schema.permissionGrants,
          and(
            eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
            eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId)
          )
        )
        .where(
          and(
            eq(schema.teamRoles.organizationId, organizationId),
            eq(schema.roleScopes.organizationId, organizationId),
            or(
              eq(schema.roleScopes.workspaceId, target.targetId),
              eq(schema.permissionGrants.workspaceId, target.targetId)
            )
          )
        )
        .orderBy(asc(schema.teams.name)),
      db
        .selectDistinct({
          id: schema.roleScopes.roleId,
          name: schema.roleScopes.displayName,
          workspaceId: schema.roleScopes.workspaceId,
        })
        .from(schema.roleScopes)
        .leftJoin(
          schema.permissionGrants,
          and(
            eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
            eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId)
          )
        )
        .where(
          and(
            eq(schema.roleScopes.organizationId, organizationId),
            or(
              eq(schema.roleScopes.workspaceId, target.targetId),
              eq(schema.permissionGrants.workspaceId, target.targetId)
            )
          )
        )
        .orderBy(asc(schema.roleScopes.displayName), asc(schema.roleScopes.roleId)),
      db
        .select({ name: schema.agentOwners.agentName })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, organizationId),
            eq(schema.agentOwners.workspaceId, target.targetId)
          )
        )
        .orderBy(asc(schema.agentOwners.agentName)),
      db
        .select({ id: schema.agentShares.id, name: schema.agentShares.agentName })
        .from(schema.agentShares)
        .where(
          and(
            eq(schema.agentShares.organizationId, organizationId),
            eq(schema.agentShares.workspaceId, target.targetId)
          )
        )
        .orderBy(asc(schema.agentShares.agentName), asc(schema.agentShares.id)),
      db
        .select({ id: schema.apiKeyScopes.apiKeyId, name: schema.apikeys.name })
        .from(schema.apiKeyScopes)
        .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, organizationId),
            eq(schema.apiKeyScopes.workspaceId, target.targetId),
            isNull(schema.apiKeyScopes.revokedAt)
          )
        )
        .orderBy(asc(schema.apikeys.name), asc(schema.apiKeyScopes.apiKeyId)),
      db
        .select({
          name: schema.workspaceInheritedResources.resourceName,
          resource: schema.workspaceInheritedResources.resource,
        })
        .from(schema.workspaceInheritedResources)
        .where(
          and(
            eq(schema.workspaceInheritedResources.organizationId, organizationId),
            eq(schema.workspaceInheritedResources.workspaceId, target.targetId)
          )
        )
        .orderBy(
          asc(schema.workspaceInheritedResources.resource),
          asc(schema.workspaceInheritedResources.resourceName)
        ),
    ])
    items.push(
      ...members.map((member) => ({
        detail: `${member.email}; direct Workspace Role access is revoked.`,
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/access/${member.id}`,
        id: `member:${member.id}`,
        label: member.name,
        severity: "critical" as const,
      })),
      ...teams.map((team) => ({
        detail: "Team-derived Workspace Role access is revoked.",
        group: "Access loss" as const,
        href: `/orgs/${orgSlug}/teams/${team.id}/roles`,
        id: `team:${team.id}`,
        label: team.name,
        severity: "critical" as const,
      })),
      ...roles.map((role) => ({
        detail: role.workspaceId
          ? "The Workspace Role and every assignment are deleted."
          : "Every grant from this Organisation Role into the Workspace is deleted.",
        group: "Roles" as const,
        href: role.workspaceId
          ? `/orgs/${orgSlug}/workspaces/${workspace.slug}/roles/${role.id}/permissions`
          : `/orgs/${orgSlug}/roles/${role.id}/permissions`,
        id: `role:${role.id}`,
        label: role.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail:
          target.operation === "workspace_delete"
            ? "Queued with the Workspace namespace for external cleanup."
            : "Agent access is revoked.",
        group: "Owned Agents" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}/agents/${encodeURIComponent(agent.name)}`,
        id: `agent:${agent.name}`,
        label: agent.name,
        severity: "critical" as const,
      })),
      ...agents.map((agent) => ({
        detail:
          "Workflows, mutable Skills, secrets, sessions, telemetry, and storage are removed with the Workspace.",
        group: "Consumers" as const,
        id: `agent-resources:${agent.name}`,
        label: `${agent.name} bound resources`,
        severity: "warning" as const,
      })),
      ...shares.map((share) => ({
        detail: "The User or Team share is removed with its Agent.",
        group: "Agent shares" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}/agents/${encodeURIComponent(share.name)}/sharing`,
        id: `share:${share.id}`,
        label: share.name,
        severity: "critical" as const,
      })),
      ...keys.map((key) => ({
        detail: "The Workspace credential is revoked transactionally.",
        group: "API keys" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}/api-keys`,
        id: `key:${key.id}`,
        label: key.name,
        severity: "critical" as const,
      })),
      ...consumers.map((consumer) => ({
        detail: "The Workspace selection of this Organisation resource is removed.",
        group: "Consumers" as const,
        href: `/orgs/${orgSlug}/workspaces/${workspace.slug}/settings/inherited`,
        id: `consumer:${consumer.resource}:${consumer.name}`,
        label: `${consumer.resource}: ${consumer.name}`,
        severity: "warning" as const,
      }))
    )
    if (target.operation === "workspace_delete") {
      items.push({
        detail: `Namespace ${workspace.namespace}, OpenBao paths, and S3 prefixes are deleted idempotently.`,
        group: "External cleanup",
        id: `external:${workspace.namespace}`,
        label: "Kubernetes, OpenBao, and S3",
        severity: "critical",
      })
    }
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ items, target, targetLabel }))
    .digest("hex")
  return { confirmation: targetLabel, fingerprint, items, target, targetLabel }
}

export async function getDestructiveImpact(orgSlug: string, target: DestructiveTarget) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) return
  return analyzeDestructiveImpact(getDB(), result.organization.id, orgSlug, target)
}

export async function deleteWorkspace(
  orgSlug: string,
  workspaceId: string,
  confirmation: string,
  fingerprint: string
) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return { error: "forbidden" as const }
  }
  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, result.organization.id))
      .for("update")
    const [authority] = await tx
      .select({ id: schema.members.id })
      .from(schema.members)
      .innerJoin(schema.memberRoles, eq(schema.memberRoles.memberId, schema.members.id))
      .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.memberRoles.roleId))
      .where(
        and(
          eq(schema.members.organizationId, result.organization.id),
          eq(schema.members.userId, result.organizationSession.session.user.id),
          isNull(schema.members.disabledAt),
          eq(schema.memberRoles.organizationId, result.organization.id),
          eq(schema.roleScopes.organizationId, result.organization.id),
          eq(schema.roleScopes.systemRole, "superadmin")
        )
      )
      .limit(1)
    if (!authority) return { error: "forbidden" as const }
    const [workspace] = await tx
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.organizationId, result.organization.id),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .for("update")
      .limit(1)
    if (!workspace) return { error: "not-found" as const }
    const target = {
      operation: "workspace_delete",
      targetId: workspace.id,
      targetType: "workspace",
    } as const
    const impact = await analyzeDestructiveImpact(
      tx,
      result.organization.id,
      result.organization.slug,
      target
    )
    if (!impact) return { error: "not-found" as const }
    if (impact.confirmation !== confirmation || impact.fingerprint !== fingerprint) {
      return { error: "stale-preview" as const }
    }

    const agents = await tx
      .select({ agentName: schema.agentOwners.agentName })
      .from(schema.agentOwners)
      .where(
        and(
          eq(schema.agentOwners.organizationId, result.organization.id),
          eq(schema.agentOwners.workspaceId, workspace.id)
        )
      )
      .orderBy(asc(schema.agentOwners.agentName))
      .for("update")
    const keyIds = await tx
      .update(schema.apiKeyScopes)
      .set({ revokedAt: new Date(), revokedReason: `Workspace ${workspace.name} deleted.` })
      .where(
        and(
          eq(schema.apiKeyScopes.organizationId, result.organization.id),
          eq(schema.apiKeyScopes.workspaceId, workspace.id),
          isNull(schema.apiKeyScopes.revokedAt)
        )
      )
      .returning({ id: schema.apiKeyScopes.apiKeyId })
    if (keyIds.length) {
      await tx
        .update(schema.apikeys)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.apikeys.referenceId, result.organization.id),
            inArray(
              schema.apikeys.id,
              keyIds.map(({ id }) => id)
            )
          )
        )
    }
    await tx
      .delete(schema.agentOwners)
      .where(
        and(
          eq(schema.agentOwners.organizationId, result.organization.id),
          eq(schema.agentOwners.workspaceId, workspace.id)
        )
      )
    const roleIds = await tx
      .select({ id: schema.roleScopes.roleId })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, result.organization.id),
          eq(schema.roleScopes.workspaceId, workspace.id)
        )
      )
    if (roleIds.length) {
      const ids = roleIds.map(({ id }) => id)
      await tx.delete(schema.memberRoles).where(inArray(schema.memberRoles.roleId, ids))
      await tx.delete(schema.teamRoles).where(inArray(schema.teamRoles.roleId, ids))
      await tx.delete(schema.invitationRoles).where(inArray(schema.invitationRoles.roleId, ids))
      await tx
        .delete(schema.socialAdmissionDefaultRoles)
        .where(inArray(schema.socialAdmissionDefaultRoles.roleId, ids))
      await tx.delete(schema.roleScopes).where(inArray(schema.roleScopes.roleId, ids))
      await tx.delete(schema.organizationRoles).where(inArray(schema.organizationRoles.id, ids))
    }
    await tx
      .delete(schema.permissionGrants)
      .where(
        and(
          eq(schema.permissionGrants.organizationId, result.organization.id),
          eq(schema.permissionGrants.workspaceId, workspace.id)
        )
      )
    await tx
      .delete(schema.workspaceInheritedResources)
      .where(
        and(
          eq(schema.workspaceInheritedResources.organizationId, result.organization.id),
          eq(schema.workspaceInheritedResources.workspaceId, workspace.id)
        )
      )
    await tx
      .delete(schema.lastAccessibleContexts)
      .where(
        and(
          eq(schema.lastAccessibleContexts.organizationId, result.organization.id),
          eq(schema.lastAccessibleContexts.workspaceId, workspace.id)
        )
      )
    const now = new Date()
    await tx
      .update(schema.workspaces)
      .set({ deletedAt: now, failureReason: null, state: "deleting", updatedAt: now })
      .where(eq(schema.workspaces.id, workspace.id))
    const cleanupId = `cleanup-${randomUUID()}`
    await tx.insert(schema.cleanupJobs).values({
      id: cleanupId,
      operation: "workspace_delete",
      organizationId: result.organization.id,
      payload: {
        api_key_count: keyIds.length,
        operation: "workspace_delete",
        owned_agent_count: agents.length,
        owned_agents: agents.map(({ agentName }) => ({
          agent_name: agentName,
          workspace_id: workspace.id,
        })),
        revokes_authorization_first: true,
        workspace_id: workspace.id,
      },
      targetId: workspace.id,
      targetType: "workspace",
      workspaceId: workspace.id,
    })
    await tx.insert(schema.auditEvents).values({
      action: "workspace.delete",
      actorId: result.organizationSession.session.user.id,
      actorType: "user",
      automaticCascade: true,
      before: [{ field: "name", value: workspace.name }],
      category: "workspace",
      cleanupJobId: cleanupId,
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(result.organizationSession.requestHeaders, getAuth().options),
      organizationId: result.organization.id,
      result: "succeeded",
      targetId: workspace.id,
      targetType: "workspace",
      userAgent: result.organizationSession.requestHeaders.get("user-agent"),
      workspaceId: workspace.id,
    })
    return { cleanupId }
  })
}

export async function retryDestructiveOperation(orgSlug: string, jobId: string) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return { error: "forbidden" as const }
  }

  return getDB().transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: schema.cleanupJobs.id,
        operation: schema.cleanupJobs.operation,
        targetId: schema.cleanupJobs.targetId,
        targetType: schema.cleanupJobs.targetType,
        workspaceId: schema.cleanupJobs.workspaceId,
      })
      .from(schema.cleanupJobs)
      .where(
        and(
          eq(schema.cleanupJobs.id, jobId),
          eq(schema.cleanupJobs.organizationId, result.organization.id),
          eq(schema.cleanupJobs.state, "failed")
        )
      )
      .for("update")
      .limit(1)
    if (!job) return { error: "not-found" as const }

    const now = new Date()
    await tx
      .update(schema.cleanupJobs)
      .set({
        completedAt: null,
        lastError: null,
        nextAttemptAt: now,
        state: "retrying",
        updatedAt: now,
      })
      .where(eq(schema.cleanupJobs.id, job.id))
    await tx.insert(schema.auditEvents).values({
      action: "cleanup.retry",
      actorId: result.organizationSession.session.user.id,
      actorType: "user",
      after: [{ field: "state", value: "retrying" }],
      automaticCascade: true,
      category: "cleanup",
      cleanupJobId: job.id,
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(result.organizationSession.requestHeaders, getAuth().options),
      organizationId: result.organization.id,
      result: "succeeded",
      targetId: job.targetId,
      targetType: job.targetType,
      userAgent: result.organizationSession.requestHeaders.get("user-agent"),
      workspaceId: job.workspaceId,
    })
    return { operation: job.operation }
  })
}

export async function listDestructiveOperations(orgSlug: string) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) return

  const rows = await getDB()
    .select({
      attempts: schema.cleanupJobs.attempts,
      completedAt: schema.cleanupJobs.completedAt,
      createdAt: schema.cleanupJobs.createdAt,
      id: schema.cleanupJobs.id,
      lastError: schema.cleanupJobs.lastError,
      leaseExpiresAt: schema.cleanupJobs.leaseExpiresAt,
      nextAttemptAt: schema.cleanupJobs.nextAttemptAt,
      operation: schema.cleanupJobs.operation,
      payload: schema.cleanupJobs.payload,
      state: schema.cleanupJobs.state,
      targetId: schema.cleanupJobs.targetId,
      targetType: schema.cleanupJobs.targetType,
    })
    .from(schema.cleanupJobs)
    .where(eq(schema.cleanupJobs.organizationId, result.organization.id))
    .orderBy(desc(schema.cleanupJobs.createdAt), desc(schema.cleanupJobs.id))
    .limit(200)

  return {
    organization: result.organization,
    rows: rows.map(
      (row): CleanupRow => ({
        ...row,
        completedAt: row.completedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        impact: [
          row.payload.revokes_authorization_first
            ? "Authorization revoked before cleanup"
            : undefined,
          row.payload.api_key_count > 0
            ? `${row.payload.api_key_count} API keys revoked`
            : undefined,
          row.payload.owned_agent_count > 0
            ? `${row.payload.owned_agent_count} owned Agents queued`
            : undefined,
        ].filter((item): item is string => Boolean(item)),
        scheduledAt:
          row.state === "running"
            ? (row.leaseExpiresAt?.toISOString() ?? null)
            : row.state === "pending" || row.state === "retrying"
              ? row.nextAttemptAt.toISOString()
              : null,
      })
    ),
  }
}
