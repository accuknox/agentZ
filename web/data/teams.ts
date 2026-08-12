import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { cacheLife, cacheTag } from "next/cache"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"
import { analyzeDestructiveImpact, analyzeTeamDeletionEffects } from "@/data/operations"
import { getAuth } from "@/lib/auth"

export type TeamMember = { id: string; name: string; email: string }
export type TeamRole = { id: string; name: string; scope: string }
export type TeamSummary = {
  id: string
  name: string
  accessibleWorkspaceCount: number
  memberCount: number
  roleCount: number
  updatedAt: string
}
export type TeamEditorData = {
  organizationId: string
  team?: {
    id: string
    name: string
    updatedAt: string
    memberIds: string[]
    roleIds: string[]
  }
  members: TeamMember[]
  roles: TeamRole[]
}
export type TeamAccessPreview = {
  fingerprint: string
  rows: { id: string; label: string; detail: string }[]
}
export type TeamDetail = TeamSummary & {
  members: TeamMember[]
  roles: TeamRole[]
  activity: {
    id: string
    action: string
    actorName: string
    result: typeof schema.auditEvents.$inferSelect.result
    createdAt: string
  }[]
}

type TeamActor = {
  organizationId: string
  requestHeaders: Headers
  userId: string
}
type TeamDatabase = Pick<ReturnType<typeof getDB>, "select">

async function getTeamActor(orgSlug: string, requireSuperadmin = true) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || (requireSuperadmin && !scope.organization.superadmin)) return
  return {
    organizationId: scope.organization.id,
    requestHeaders: scope.organizationSession.requestHeaders,
    userId: scope.organizationSession.session.user.id,
  } satisfies TeamActor
}

function teamAudit(
  actor: TeamActor,
  action: string,
  targetId: string,
  result: typeof schema.auditEvents.$inferInsert.result,
  before?: typeof schema.auditEvents.$inferInsert.before,
  after?: typeof schema.auditEvents.$inferInsert.after
) {
  return {
    actorId: actor.userId,
    actorType: "user" as const,
    action,
    after,
    automaticCascade: false,
    before,
    category: "team",
    id: `audit-${randomUUID()}`,
    interface: "web" as const,
    ipAddress: getIp(actor.requestHeaders, getAuth().options),
    organizationId: actor.organizationId,
    result,
    targetId,
    targetType: "team" as const,
    userAgent: actor.requestHeaders.get("user-agent"),
  }
}

async function isSuperadmin(db: TeamDatabase, actor: TeamActor) {
  const [role] = await db
    .select({ id: schema.memberRoles.roleId })
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
        eq(schema.members.organizationId, actor.organizationId),
        eq(schema.members.userId, actor.userId),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.systemRole, "superadmin"),
        eq(schema.roleScopes.immutable, true),
        isNull(schema.roleScopes.workspaceId)
      )
    )
    .limit(1)
  return Boolean(role)
}

export async function listTeams(orgSlug: string) {
  "use cache: private"
  cacheLife({ stale: 30 })
  const actor = await getTeamActor(orgSlug)
  if (!actor) return
  cacheTag(`organization:${actor.organizationId}:teams`)

  const rows = await getDB()
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      memberCount: sql<number>`(
        SELECT count(*)::int FROM team_members
        WHERE team_id = ${sql.raw('"teams"."id"')}
      )`,
      roleCount: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE team_id = ${sql.raw('"teams"."id"')}
          AND organization_id = ${actor.organizationId}
      )`,
      accessibleWorkspaceCount: sql<number>`(
        SELECT count(DISTINCT workspace_id)::int FROM (
          SELECT role_scopes.workspace_id
          FROM team_roles
          JOIN role_scopes
            ON role_scopes.role_id = team_roles.role_id
           AND role_scopes.organization_id = team_roles.organization_id
          WHERE team_roles.team_id = ${sql.raw('"teams"."id"')}
            AND role_scopes.workspace_id IS NOT NULL
          UNION
          SELECT permission_grants.workspace_id
          FROM team_roles
          JOIN permission_grants
            ON permission_grants.role_id = team_roles.role_id
           AND permission_grants.organization_id = team_roles.organization_id
          WHERE team_roles.team_id = ${sql.raw('"teams"."id"')}
            AND permission_grants.workspace_id IS NOT NULL
        ) accessible_workspaces
      )`,
      updatedAt: schema.teams.updatedAt,
      createdAt: schema.teams.createdAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.organizationId, actor.organizationId))
    .orderBy(asc(schema.teams.name), asc(schema.teams.id))

  return {
    organizationId: actor.organizationId,
    teams: rows.map(({ createdAt, updatedAt, ...team }) => ({
      ...team,
      updatedAt: (updatedAt ?? createdAt).toISOString(),
    })),
  }
}

export async function getTeamEditorData(
  orgSlug: string,
  teamId?: string
): Promise<TeamEditorData | undefined> {
  "use cache: private"
  cacheLife({ stale: 30 })
  const actor = await getTeamActor(orgSlug)
  if (!actor) return
  cacheTag(
    `organization:${actor.organizationId}:teams`,
    ...(teamId ? [`organization:${actor.organizationId}:team:${teamId}`] : [])
  )

  const members = await getDB()
    .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.members.organizationId, actor.organizationId),
        isNull(schema.members.disabledAt)
      )
    )
    .orderBy(asc(schema.users.name), asc(schema.users.email))
  const roles = await getDB()
    .select({
      id: schema.roleScopes.roleId,
      name: schema.roleScopes.displayName,
      workspace: schema.workspaces.name,
    })
    .from(schema.roleScopes)
    .leftJoin(
      schema.workspaces,
      and(
        eq(schema.workspaces.id, schema.roleScopes.workspaceId),
        eq(schema.workspaces.organizationId, schema.roleScopes.organizationId)
      )
    )
    .where(
      and(
        eq(schema.roleScopes.organizationId, actor.organizationId),
        eq(schema.roleScopes.immutable, false),
        isNull(schema.roleScopes.systemRole),
        or(isNull(schema.roleScopes.workspaceId), isNull(schema.workspaces.deletedAt))
      )
    )
    .orderBy(asc(schema.workspaces.name), asc(schema.roleScopes.displayName))
  const data: TeamEditorData = {
    organizationId: actor.organizationId,
    members,
    roles: roles.map(({ workspace, ...role }) => ({
      ...role,
      scope: workspace ?? "Organisation",
    })),
  }
  if (!teamId) return data

  const [team] = await getDB()
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      updatedAt: schema.teams.updatedAt,
      createdAt: schema.teams.createdAt,
    })
    .from(schema.teams)
    .where(and(eq(schema.teams.id, teamId), eq(schema.teams.organizationId, actor.organizationId)))
    .limit(1)
  if (!team) return data

  const [assignedMembers, assignedRoles] = await Promise.all([
    getDB()
      .select({ memberId: schema.members.id })
      .from(schema.teamMembers)
      .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
      .where(
        and(
          eq(schema.teamMembers.teamId, team.id),
          eq(schema.members.organizationId, actor.organizationId),
          isNull(schema.members.disabledAt)
        )
      ),
    getDB()
      .select({ roleId: schema.teamRoles.roleId })
      .from(schema.teamRoles)
      .where(
        and(
          eq(schema.teamRoles.teamId, team.id),
          eq(schema.teamRoles.organizationId, actor.organizationId)
        )
      ),
  ])
  return {
    ...data,
    team: {
      id: team.id,
      name: team.name,
      updatedAt: (team.updatedAt ?? team.createdAt).toISOString(),
      memberIds: assignedMembers.map(({ memberId }) => memberId),
      roleIds: assignedRoles.map(({ roleId }) => roleId),
    },
  }
}

async function accessPreview(
  db: TeamDatabase,
  actor: TeamActor,
  memberIds: string[],
  roleIds: string[]
) {
  const selectedMembers = [...new Set(memberIds)].sort()
  const selectedRoles = [...new Set(roleIds)].sort()
  if (!selectedMembers.length || !selectedRoles.length) return

  const [members, roles, grants] = await Promise.all([
    db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, actor.organizationId),
          isNull(schema.members.disabledAt),
          inArray(schema.members.id, selectedMembers)
        )
      ),
    db
      .select({
        id: schema.roleScopes.roleId,
        name: schema.roleScopes.displayName,
        workspace: schema.workspaces.name,
        updatedAt: schema.roleScopes.updatedAt,
      })
      .from(schema.roleScopes)
      .leftJoin(
        schema.workspaces,
        and(
          eq(schema.workspaces.id, schema.roleScopes.workspaceId),
          eq(schema.workspaces.organizationId, schema.roleScopes.organizationId)
        )
      )
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organizationId),
          eq(schema.roleScopes.immutable, false),
          isNull(schema.roleScopes.systemRole),
          inArray(schema.roleScopes.roleId, selectedRoles),
          or(isNull(schema.roleScopes.workspaceId), isNull(schema.workspaces.deletedAt))
        )
      ),
    db
      .select({
        roleId: schema.permissionGrants.roleId,
        resource: schema.permissionGrants.resource,
        action: schema.permissionGrants.action,
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
          eq(schema.permissionGrants.organizationId, actor.organizationId),
          ne(schema.permissionGrants.resource, "api_key"),
          inArray(schema.permissionGrants.roleId, selectedRoles)
        )
      ),
  ])
  if (members.length !== selectedMembers.length || roles.length !== selectedRoles.length) return

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        memberIds: selectedMembers,
        roles: roles
          .map(({ id, updatedAt }) => ({ id, updatedAt: updatedAt.toISOString() }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      })
    )
    .digest("hex")
  const rows = roles.map((role) => {
    const permissions =
      [
        ...new Set(
          grants
            .filter(({ roleId }) => roleId === role.id)
            .map(({ resource, action }) => `${resource}:${action}`)
        ),
      ]
        .sort()
        .join(", ") || "No permissions"
    return {
      id: role.id,
      label: role.name,
      detail: `${role.workspace ?? "Organisation"} · ${permissions}`,
    }
  })
  return { fingerprint, rows } satisfies TeamAccessPreview
}

export async function previewTeamAccess(
  orgSlug: string,
  input: { memberIds: string[]; roleIds: string[] }
) {
  const actor = await getTeamActor(orgSlug)
  return actor ? accessPreview(getDB(), actor, input.memberIds, input.roleIds) : undefined
}

export async function saveTeam(
  orgSlug: string,
  teamId: string | undefined,
  input: {
    name: string
    memberIds: string[]
    roleIds: string[]
    updatedAt?: string
    previewFingerprint: string
  }
) {
  const actor = await getTeamActor(orgSlug, false)
  if (!actor) return { error: "forbidden" as const }

  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.organizationId))
      .for("update")
    if (!(await isSuperadmin(tx, actor))) {
      await tx
        .insert(schema.auditEvents)
        .values(teamAudit(actor, teamId ? "team.update" : "team.create", teamId ?? "new", "denied"))
      return { error: "forbidden" as const }
    }
    const action = teamId ? "team.update" : "team.create"
    const attempt = (result: "failed" | "denied") =>
      tx.insert(schema.auditEvents).values(teamAudit(actor, action, teamId ?? "new", result))
    const preview = await accessPreview(tx, actor, input.memberIds, input.roleIds)
    if (!preview) {
      await attempt("failed")
      return { error: "invalid" as const }
    }
    if (preview.fingerprint !== input.previewFingerprint) {
      await attempt("failed")
      return { error: "preview-required" as const }
    }

    const [taken] = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(
        and(
          eq(schema.teams.organizationId, actor.organizationId),
          eq(sql`lower(${schema.teams.name})`, input.name.toLowerCase()),
          teamId ? ne(schema.teams.id, teamId) : undefined
        )
      )
      .limit(1)
    if (taken) {
      await attempt("failed")
      return { error: "name-taken" as const }
    }

    let team: { id: string; name: string; updatedAt: Date }
    if (teamId) {
      const [stored] = await tx
        .select({
          id: schema.teams.id,
          name: schema.teams.name,
          updatedAt: schema.teams.updatedAt,
          createdAt: schema.teams.createdAt,
        })
        .from(schema.teams)
        .where(
          and(eq(schema.teams.id, teamId), eq(schema.teams.organizationId, actor.organizationId))
        )
        .for("update")
        .limit(1)
      if (!stored) {
        await attempt("failed")
        return { error: "not-found" as const }
      }
      const updatedAt = stored.updatedAt ?? stored.createdAt
      if (updatedAt.toISOString() !== input.updatedAt) {
        await attempt("failed")
        return { error: "stale" as const }
      }
      team = { id: stored.id, name: stored.name, updatedAt }
    } else {
      team = { id: randomUUID(), name: input.name, updatedAt: new Date() }
    }

    const memberIds = [...new Set(input.memberIds)]
    const roleIds = [...new Set(input.roleIds)]
    const selectedMembers = await tx
      .select({ id: schema.members.id, userId: schema.members.userId })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, actor.organizationId),
          isNull(schema.members.disabledAt),
          inArray(schema.members.id, memberIds)
        )
      )
    const selectedRoles = await tx
      .select({ id: schema.roleScopes.roleId })
      .from(schema.roleScopes)
      .leftJoin(
        schema.workspaces,
        and(
          eq(schema.workspaces.id, schema.roleScopes.workspaceId),
          eq(schema.workspaces.organizationId, schema.roleScopes.organizationId)
        )
      )
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organizationId),
          eq(schema.roleScopes.immutable, false),
          isNull(schema.roleScopes.systemRole),
          inArray(schema.roleScopes.roleId, roleIds),
          or(isNull(schema.roleScopes.workspaceId), isNull(schema.workspaces.deletedAt))
        )
      )
    if (selectedMembers.length !== memberIds.length || selectedRoles.length !== roleIds.length) {
      await attempt("failed")
      return { error: "invalid" as const }
    }

    const [currentMembers, currentRoles] = teamId
      ? await Promise.all([
          tx
            .select({ memberId: schema.members.id, userId: schema.teamMembers.userId })
            .from(schema.teamMembers)
            .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
            .where(
              and(
                eq(schema.teamMembers.teamId, team.id),
                eq(schema.members.organizationId, actor.organizationId)
              )
            ),
          tx
            .select({ roleId: schema.teamRoles.roleId })
            .from(schema.teamRoles)
            .where(
              and(
                eq(schema.teamRoles.teamId, team.id),
                eq(schema.teamRoles.organizationId, actor.organizationId)
              )
            ),
        ])
      : [[], []]

    const affectedMemberIds = [
      ...new Set([...memberIds, ...currentMembers.map(({ memberId }) => memberId)]),
    ]
    await tx
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, actor.organizationId),
          inArray(schema.members.id, affectedMemberIds)
        )
      )
      .for("update")

    if (teamId) {
      await tx
        .update(schema.teams)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(schema.teams.id, team.id))
    } else {
      await tx.insert(schema.teams).values({
        id: team.id,
        name: input.name,
        organizationId: actor.organizationId,
        createdAt: team.updatedAt,
        updatedAt: team.updatedAt,
      })
    }

    await tx.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, team.id))
    await tx.delete(schema.teamRoles).where(eq(schema.teamRoles.teamId, team.id))
    await tx
      .insert(schema.teamMembers)
      .values(selectedMembers.map(({ userId }) => ({ id: randomUUID(), teamId: team.id, userId })))
    await tx
      .insert(schema.teamRoles)
      .values(
        roleIds.map((roleId) => ({ teamId: team.id, roleId, organizationId: actor.organizationId }))
      )
    await tx.insert(schema.auditEvents).values(
      teamAudit(
        actor,
        teamId ? "team.update" : "team.create",
        team.id,
        "succeeded",
        teamId
          ? [
              { field: "name", value: team.name },
              ...currentMembers.map(({ userId }) => ({
                field: "user_id" as const,
                value: userId,
              })),
              ...currentRoles.map(({ roleId }) => ({ field: "role" as const, value: roleId })),
            ]
          : undefined,
        [
          { field: "name", value: input.name },
          ...selectedMembers.map(({ userId }) => ({ field: "user_id" as const, value: userId })),
          ...roleIds.map((roleId) => ({ field: "role" as const, value: roleId })),
        ]
      )
    )
    return {
      organizationId: actor.organizationId,
      teamId: team.id,
      affectedMemberIds,
    }
  })
}

export async function deleteTeam(
  orgSlug: string,
  teamId: string,
  confirmation: string,
  fingerprint: string
) {
  const actor = await getTeamActor(orgSlug, false)
  if (!actor) return { error: "forbidden" as const }
  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.organizationId))
      .for("update")
    const [team] = await tx
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        and(eq(schema.teams.id, teamId), eq(schema.teams.organizationId, actor.organizationId))
      )
      .for("update")
      .limit(1)
    if (!team) return { error: "not-found" as const }
    if (!(await isSuperadmin(tx, actor))) {
      await tx.insert(schema.auditEvents).values(teamAudit(actor, "team.delete", team.id, "denied"))
      return { error: "forbidden" as const }
    }
    const teamUsers = await tx
      .select({ userId: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, team.id))
    if (teamUsers.length) {
      await tx
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(
          and(
            eq(schema.members.organizationId, actor.organizationId),
            inArray(
              schema.members.userId,
              teamUsers.map(({ userId }) => userId)
            )
          )
        )
        .for("update")
    }
    let effects = await analyzeTeamDeletionEffects(tx, actor.organizationId, team.id)
    if (!effects) return { error: "not-found" as const }
    if (effects.agents.length) {
      await tx
        .select({ agentName: schema.agentOwners.agentName })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, actor.organizationId),
            or(
              ...effects.agents.map((agent) =>
                and(
                  eq(schema.agentOwners.workspaceId, agent.workspaceId),
                  eq(schema.agentOwners.agentName, agent.agentName)
                )
              )
            )
          )
        )
        .for("update")
      effects = await analyzeTeamDeletionEffects(tx, actor.organizationId, team.id)
      if (!effects) return { error: "not-found" as const }
    }
    const target = { operation: "team_delete", targetId: team.id, targetType: "team" } as const
    const impact = await analyzeDestructiveImpact(tx, actor.organizationId, orgSlug, target)
    if (!impact) return { error: "not-found" as const }
    if (impact.confirmation !== confirmation || impact.fingerprint !== fingerprint) {
      return { error: "stale-preview" as const }
    }
    const now = new Date()
    if (effects.keys.length) {
      const keyIds = effects.keys.map(({ id }) => id)
      await tx
        .update(schema.apiKeyScopes)
        .set({ revokedAt: now, revokedReason: `Team ${team.name} deletion removed access.` })
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, actor.organizationId),
            inArray(schema.apiKeyScopes.apiKeyId, keyIds),
            isNull(schema.apiKeyScopes.revokedAt)
          )
        )
      await tx
        .update(schema.apikeys)
        .set({ enabled: false, updatedAt: now })
        .where(
          and(
            eq(schema.apikeys.referenceId, actor.organizationId),
            inArray(schema.apikeys.id, keyIds)
          )
        )
    }
    if (effects.agents.length) {
      await tx
        .delete(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, actor.organizationId),
            or(
              ...effects.agents.map((agent) =>
                and(
                  eq(schema.agentOwners.workspaceId, agent.workspaceId),
                  eq(schema.agentOwners.agentName, agent.agentName)
                )
              )
            )
          )
        )
    }
    await tx
      .delete(schema.invitationTeams)
      .where(
        and(
          eq(schema.invitationTeams.organizationId, actor.organizationId),
          eq(schema.invitationTeams.teamId, team.id)
        )
      )
    await tx
      .delete(schema.socialAdmissionDefaultTeams)
      .where(
        and(
          eq(schema.socialAdmissionDefaultTeams.organizationId, actor.organizationId),
          eq(schema.socialAdmissionDefaultTeams.teamId, team.id)
        )
      )
    await tx.delete(schema.teams).where(eq(schema.teams.id, team.id))
    const cleanupId = `cleanup-${randomUUID()}`
    await tx.insert(schema.cleanupJobs).values({
      id: cleanupId,
      operation: "team_delete",
      organizationId: actor.organizationId,
      payload: {
        api_key_count: effects.keys.length,
        operation: "team_delete",
        owned_agent_count: effects.agents.length,
        owned_agents: effects.agents.map((agent) => ({
          agent_name: agent.agentName,
          workspace_id: agent.workspaceId,
        })),
        revokes_authorization_first: true,
        team_id: team.id,
      },
      targetId: team.id,
      targetType: "team",
    })
    await tx.insert(schema.auditEvents).values({
      ...teamAudit(actor, "team.delete", team.id, "succeeded", [
        { field: "name", value: team.name },
      ]),
      automaticCascade: true,
      cleanupJobId: cleanupId,
    })
    return {
      cleanupId,
      organizationId: actor.organizationId,
      affectedMemberIds: effects.members.map(({ memberId }) => memberId),
    }
  })
}

export async function getTeamDetail(orgSlug: string, teamId: string) {
  const editor = await getTeamEditorData(orgSlug, teamId)
  if (!editor?.team) return
  const summary = (await listTeams(orgSlug))?.teams.find(({ id }) => id === teamId)
  if (!summary) return
  const selectedMembers = new Set(editor.team.memberIds)
  const selectedRoles = new Set(editor.team.roleIds)
  const activity = await getDB()
    .select({
      id: schema.auditEvents.id,
      action: schema.auditEvents.action,
      actorName: schema.users.name,
      result: schema.auditEvents.result,
      createdAt: schema.auditEvents.createdAt,
    })
    .from(schema.auditEvents)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditEvents.actorId))
    .where(
      and(
        eq(schema.auditEvents.organizationId, editor.organizationId),
        eq(schema.auditEvents.targetType, "team"),
        eq(schema.auditEvents.targetId, teamId)
      )
    )
    .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
    .limit(50)
  return {
    ...summary,
    members: editor.members.filter(({ id }) => selectedMembers.has(id)),
    roles: editor.roles.filter(({ id }) => selectedRoles.has(id)),
    activity: activity.map(({ actorName, createdAt, ...event }) => ({
      ...event,
      actorName: actorName ?? "System",
      createdAt: createdAt.toISOString(),
    })),
  } satisfies TeamDetail
}
