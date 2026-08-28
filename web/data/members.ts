import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { generateId } from "@better-auth/core/utils/id"
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { headers } from "next/headers"
import { cache } from "react"
import { z } from "zod"
import { getDB, schema } from "@/db"
import {
  assertActiveSuperadmin,
  lockOrganizationForSuperadmin,
  preserveActiveSuperadmin,
  resolveOrganizationSlug,
} from "@/data/organizations"
import { analyzeDestructiveImpact, type DestructiveTarget } from "@/data/operations"
import { getAuth, projectMemberRoleTransports } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { dayjs } from "@/lib/format"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { invitationExpiresIn } from "@/lib/organization-invitation"
import { decodePageToken, encodePageToken } from "@/data/page-token"

const memberPageCursor = z.object({ email: z.string(), id: z.string().min(1), name: z.string() })
const invitationPageCursor = z.object({ createdAt: z.string().datetime(), id: z.string().min(1) })

export type MemberTab = "active" | "invited" | "disabled"

export type MemberDirectory = {
  actorUserId: string
  organization: { id: string; name: string; slug: string }
  active: ActiveMember[]
  disabled: ActiveMember[]
  invited: InvitationRow[]
  roles: ScopedAssignmentOption[]
  teams: AssignmentOption[]
  nextPageToken: string
}

export type ActiveMember = {
  id: string
  userId: string
  name: string
  email: string
  image: string | null
  createdAt: string
  disabledAt: string | null
  roles: string[]
  roleIds: string[]
  teams: string[]
  teamIds: string[]
  ownedAgents: number
  apiKeys: number
  sharedAgents: number
  lastActivity: string | null
  superadmin: boolean
}

export type InvitationRow = {
  id: string
  expiresAt: string
  createdAt: string
  inviterEmail: string
  inviterImage: string | null
  inviterName: string
  roles: string[]
  teams: string[]
  expired: boolean
}

export type AssignmentOption = { id: string; name: string }
export type ScopedAssignmentOption = {
  id: string
  name: string
  scope: string
  workspace: string | null
}

export type MessageActorProfile = { id: string; image: string | null; name: string }

export async function getMessageActorProfiles(userIds: string[]): Promise<MessageActorProfile[]> {
  if (userIds.length === 0) {
    return []
  }

  const auth = await currentGatewayAuthContext()
  return getDB()
    .select({ id: schema.users.id, image: schema.users.image, name: schema.users.name })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.members.organizationId, auth.organizationId),
        isNull(schema.members.disabledAt),
        inArray(schema.members.userId, userIds)
      )
    )
    .limit(userIds.length)
}

export type MemberAdministration = {
  organization: { id: string; name: string; slug: string }
  member: ActiveMember
  roles: ScopedAssignmentOption[]
  teams: AssignmentOption[]
  self: boolean
  agents: { name: string; workspace: string; workspaceSlug: string; updatedAt: string }[]
  apiKeys: {
    id: string
    name: string
    workspace: string
    workspaceSlug: string
    createdAt: string
    revokedAt: string | null
  }[]
  activity: {
    id: string
    action: string
    actor: string
    createdAt: string
    result: typeof schema.eventTrailEvents.$inferSelect.result
  }[]
}

export type SocialAdmission = {
  organization: { id: string; name: string; slug: string }
  enabled: boolean
  googleEnabled: boolean
  githubEnabled: boolean
  googleConfigured: boolean
  githubConfigured: boolean
  googleDomains: string[]
  githubRules: { id: string; organization: string; team: string | null }[]
  roles: (ScopedAssignmentOption & { workspaceIds: string[] })[]
  teams: (AssignmentOption & { workspaceIds: string[] })[]
  workspaces: AssignmentOption[]
  defaultRoleIds: string[]
  defaultTeamIds: string[]
  joinLink: string
}

type Actor = {
  organization: { id: string; name: string; slug: string }
  userId: string
}
async function superadminActor(orgSlug: string): Promise<Actor | undefined> {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return
  }

  return {
    organization: result.organization,
    userId: result.organizationSession.session.user.id,
  }
}

export async function getMemberDirectory(
  orgSlug: string,
  page?: { tab: MemberTab; pageToken?: string }
): Promise<MemberDirectory | undefined> {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return
  }

  const db = getDB()
  const memberCursor =
    page?.tab === "active" || page?.tab === "disabled"
      ? decodePageToken(memberPageCursor, page.pageToken)
      : undefined
  const invitationCursor =
    page?.tab === "invited" ? decodePageToken(invitationPageCursor, page.pageToken) : undefined
  const [members, invitations, roleRows, teamRows] = await Promise.all([
    db
      .select({
        id: schema.members.id,
        userId: schema.members.userId,
        name: schema.users.name,
        email: schema.users.email,
        image: schema.users.image,
        createdAt: schema.members.createdAt,
        disabledAt: schema.members.disabledAt,
        lastActivity: sql`(
          SELECT max(${schema.sessions.updatedAt})
          FROM ${schema.sessions}
          WHERE ${schema.sessions.userId} = ${schema.members.userId}
        )`.mapWith(schema.sessions.updatedAt),
        ownedAgents: sql<number>`(
          SELECT count(*)::int
          FROM ${schema.agentOwners}
          WHERE ${schema.agentOwners.organizationId} = ${actor.organization.id}
            AND ${schema.agentOwners.ownerUserId} = ${schema.members.userId}
        )`,
        apiKeys: sql<number>`(
          SELECT count(*)::int
          FROM ${schema.apiKeyScopes}
          WHERE ${schema.apiKeyScopes.organizationId} = ${actor.organization.id}
            AND ${schema.apiKeyScopes.creatorUserId} = ${schema.members.userId}
        )`,
        sharedAgents: sql<number>`(
          SELECT count(DISTINCT ${schema.agentShares.agentName})::int
          FROM ${schema.agentShares}
          LEFT JOIN ${schema.teamMembers}
            ON ${schema.teamMembers.teamId} = ${schema.agentShares.targetTeamId}
          WHERE ${schema.agentShares.organizationId} = ${actor.organization.id}
            AND (
              ${schema.agentShares.targetUserId} = ${schema.members.userId}
              OR ${schema.teamMembers.userId} = ${schema.members.userId}
            )
        )`,
      })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.members.organizationId, actor.organization.id),
          page?.tab === "active" ? isNull(schema.members.disabledAt) : undefined,
          page?.tab === "disabled" ? isNotNull(schema.members.disabledAt) : undefined,
          page?.tab === "invited" ? sql`false` : undefined,
          memberCursor
            ? or(
                gt(schema.users.name, memberCursor.name),
                and(
                  eq(schema.users.name, memberCursor.name),
                  gt(schema.users.email, memberCursor.email)
                ),
                and(
                  eq(schema.users.name, memberCursor.name),
                  eq(schema.users.email, memberCursor.email),
                  gt(schema.members.id, memberCursor.id)
                )
              )
            : undefined
        )
      )
      .orderBy(asc(schema.users.name), asc(schema.users.email), asc(schema.members.id))
      .limit(page ? 51 : 500),
    db
      .select({
        id: schema.organizationInvitations.id,
        expiresAt: schema.organizationInvitations.expiresAt,
        createdAt: schema.organizationInvitations.createdAt,
        inviterEmail: schema.users.email,
        inviterImage: schema.users.image,
        inviterName: schema.users.name,
      })
      .from(schema.organizationInvitations)
      .innerJoin(schema.users, eq(schema.users.id, schema.organizationInvitations.inviterId))
      .where(
        and(
          eq(schema.organizationInvitations.organizationId, actor.organization.id),
          eq(schema.organizationInvitations.status, "pending"),
          page?.tab && page.tab !== "invited" ? sql`false` : undefined,
          invitationCursor
            ? or(
                lt(
                  schema.organizationInvitations.createdAt,
                  dayjs(invitationCursor.createdAt).toDate()
                ),
                and(
                  eq(
                    schema.organizationInvitations.createdAt,
                    dayjs(invitationCursor.createdAt).toDate()
                  ),
                  lt(schema.organizationInvitations.id, invitationCursor.id)
                )
              )
            : undefined
        )
      )
      .orderBy(
        desc(schema.organizationInvitations.createdAt),
        desc(schema.organizationInvitations.id)
      )
      .limit(page ? 51 : 500),
    db
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
          eq(schema.roleScopes.organizationId, actor.organization.id),
          or(isNull(schema.roleScopes.workspaceId), isNull(schema.workspaces.deletedAt))
        )
      )
      .orderBy(
        sql`${schema.workspaces.name} ASC NULLS FIRST`,
        asc(schema.roleScopes.displayName),
        asc(schema.roleScopes.roleId)
      )
      .limit(500),
    db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.organizationId, actor.organization.id))
      .orderBy(asc(schema.teams.name), asc(schema.teams.id))
      .limit(500),
  ])

  const memberPage = page && members.length > 50 ? members.slice(0, 50) : members
  const invitationPage = page && invitations.length > 50 ? invitations.slice(0, 50) : invitations
  const memberIds = memberPage.map((member) => member.id)
  const userIds = memberPage.map((member) => member.userId)
  const invitationIds = invitationPage.map((invitation) => invitation.id)
  const [memberRoles, memberTeams, invitationRoles, invitationTeams, superadminRoles] =
    await Promise.all([
      memberIds.length
        ? db
            .select({
              memberId: schema.memberRoles.memberId,
              name: schema.roleScopes.displayName,
              roleId: schema.memberRoles.roleId,
            })
            .from(schema.memberRoles)
            .innerJoin(
              schema.roleScopes,
              and(
                eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
                eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
              )
            )
            .where(
              and(
                eq(schema.memberRoles.organizationId, actor.organization.id),
                inArray(schema.memberRoles.memberId, memberIds)
              )
            )
        : [],
      userIds.length
        ? db
            .select({
              userId: schema.teamMembers.userId,
              name: schema.teams.name,
              teamId: schema.teamMembers.teamId,
            })
            .from(schema.teamMembers)
            .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
            .where(
              and(
                eq(schema.teams.organizationId, actor.organization.id),
                inArray(schema.teamMembers.userId, userIds)
              )
            )
        : [],
      invitationIds.length
        ? db
            .select({
              invitationId: schema.invitationRoles.invitationId,
              name: schema.roleScopes.displayName,
            })
            .from(schema.invitationRoles)
            .innerJoin(
              schema.roleScopes,
              and(
                eq(schema.roleScopes.roleId, schema.invitationRoles.roleId),
                eq(schema.roleScopes.organizationId, schema.invitationRoles.organizationId)
              )
            )
            .where(inArray(schema.invitationRoles.invitationId, invitationIds))
        : [],
      invitationIds.length
        ? db
            .select({
              invitationId: schema.invitationTeams.invitationId,
              name: schema.teams.name,
            })
            .from(schema.invitationTeams)
            .innerJoin(schema.teams, eq(schema.teams.id, schema.invitationTeams.teamId))
            .where(inArray(schema.invitationTeams.invitationId, invitationIds))
        : [],
      memberIds.length
        ? db
            .selectDistinct({ memberId: schema.memberRoleAssignments.memberId })
            .from(schema.memberRoleAssignments)
            .innerJoin(
              schema.roleScopes,
              and(
                eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
                eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
              )
            )
            .where(
              and(
                eq(schema.memberRoleAssignments.organizationId, actor.organization.id),
                inArray(schema.memberRoleAssignments.memberId, memberIds),
                eq(schema.roleScopes.systemRole, "superadmin")
              )
            )
        : [],
    ])

  const rolesByMember = new Map<string, string[]>()
  const roleIdsByMember = new Map<string, string[]>()
  for (const role of memberRoles) {
    rolesByMember.set(role.memberId, [...(rolesByMember.get(role.memberId) ?? []), role.name])
    roleIdsByMember.set(role.memberId, [...(roleIdsByMember.get(role.memberId) ?? []), role.roleId])
  }
  const superadminMembers = new Set(superadminRoles.map(({ memberId }) => memberId))

  const teamsByUser = new Map<string, string[]>()
  const teamIdsByUser = new Map<string, string[]>()
  for (const team of memberTeams) {
    teamsByUser.set(team.userId, [...(teamsByUser.get(team.userId) ?? []), team.name])
    teamIdsByUser.set(team.userId, [...(teamIdsByUser.get(team.userId) ?? []), team.teamId])
  }

  const rolesByInvitation = new Map<string, string[]>()
  for (const role of invitationRoles) {
    rolesByInvitation.set(role.invitationId, [
      ...(rolesByInvitation.get(role.invitationId) ?? []),
      role.name,
    ])
  }

  const teamsByInvitation = new Map<string, string[]>()
  for (const team of invitationTeams) {
    teamsByInvitation.set(team.invitationId, [
      ...(teamsByInvitation.get(team.invitationId) ?? []),
      team.name,
    ])
  }

  const active: ActiveMember[] = []
  const disabled: ActiveMember[] = []
  for (const member of memberPage) {
    const row = {
      ...member,
      createdAt: dayjs(member.createdAt).toISOString(),
      disabledAt: member.disabledAt ? dayjs(member.disabledAt).toISOString() : null,
      lastActivity: member.lastActivity ? dayjs(member.lastActivity).toISOString() : null,
      roleIds: roleIdsByMember.get(member.id) ?? [],
      roles: rolesByMember.get(member.id) ?? [],
      superadmin: superadminMembers.has(member.id),
      teams: teamsByUser.get(member.userId) ?? [],
      teamIds: teamIdsByUser.get(member.userId) ?? [],
    }
    if (member.disabledAt) {
      disabled.push(row)
      continue
    }
    active.push(row)
  }

  const now = dayjs()
  const lastMember = memberPage.at(-1)
  const lastInvitation = invitationPage.at(-1)
  const nextPageToken =
    page?.tab === "invited"
      ? invitations.length > 50 && lastInvitation
        ? encodePageToken({
            createdAt: dayjs(lastInvitation.createdAt).toISOString(),
            id: lastInvitation.id,
          })
        : ""
      : page && members.length > 50 && lastMember
        ? encodePageToken({ email: lastMember.email, id: lastMember.id, name: lastMember.name })
        : ""
  return {
    active,
    actorUserId: actor.userId,
    disabled,
    invited: invitationPage.map((invitation) => ({
      ...invitation,
      createdAt: dayjs(invitation.createdAt).toISOString(),
      expired: !dayjs(invitation.expiresAt).isAfter(now),
      expiresAt: dayjs(invitation.expiresAt).toISOString(),
      roles: rolesByInvitation.get(invitation.id) ?? [],
      teams: teamsByInvitation.get(invitation.id) ?? [],
    })),
    organization: actor.organization,
    nextPageToken,
    roles: roleRows.map((role) => ({
      ...role,
      scope: role.workspace === null ? "Organisation" : `Workspace · ${role.workspace}`,
    })),
    teams: teamRows,
  }
}

export const getMemberAdministration = cache(
  async (orgSlug: string, memberId: string): Promise<MemberAdministration | null | undefined> => {
    const directory = await getMemberDirectory(orgSlug)
    if (!directory) return
    const member = [...directory.active, ...directory.disabled].find(
      (candidate) => candidate.id === memberId
    )
    if (!member) return null

    const db = getDB()
    const [agents, apiKeys, activity] = await Promise.all([
      db
        .select({
          name: schema.agentOwners.agentName,
          updatedAt: schema.agentOwners.updatedAt,
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
            eq(schema.agentOwners.organizationId, directory.organization.id),
            eq(schema.agentOwners.ownerUserId, member.userId)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.agentOwners.agentName))
        .limit(500),
      db
        .select({
          createdAt: schema.apiKeyScopes.createdAt,
          id: schema.apiKeyScopes.apiKeyId,
          name: schema.apikeys.name,
          revokedAt: schema.apiKeyScopes.revokedAt,
          workspace: schema.workspaces.name,
          workspaceSlug: schema.workspaces.slug,
        })
        .from(schema.apiKeyScopes)
        .innerJoin(schema.apikeys, eq(schema.apikeys.id, schema.apiKeyScopes.apiKeyId))
        .innerJoin(
          schema.workspaces,
          and(
            eq(schema.workspaces.id, schema.apiKeyScopes.workspaceId),
            eq(schema.workspaces.organizationId, schema.apiKeyScopes.organizationId)
          )
        )
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, directory.organization.id),
            eq(schema.apiKeyScopes.creatorUserId, member.userId)
          )
        )
        .orderBy(desc(schema.apiKeyScopes.createdAt), desc(schema.apiKeyScopes.apiKeyId))
        .limit(500),
      db
        .select({
          action: schema.eventTrailEvents.action,
          createdAt: schema.eventTrailEvents.createdAt,
          id: schema.eventTrailEvents.id,
          result: schema.eventTrailEvents.result,
        })
        .from(schema.eventTrailEvents)
        .where(
          and(
            eq(schema.eventTrailEvents.organizationId, directory.organization.id),
            eq(schema.eventTrailEvents.actorId, member.userId)
          )
        )
        .orderBy(desc(schema.eventTrailEvents.createdAt), desc(schema.eventTrailEvents.id))
        .limit(100),
    ])

    return {
      activity: activity.map(({ createdAt, ...event }) => ({
        ...event,
        actor: member.name,
        createdAt: dayjs(createdAt).toISOString(),
      })),
      agents: agents.map(({ updatedAt, ...agent }) => ({
        ...agent,
        updatedAt: dayjs(updatedAt).toISOString(),
      })),
      apiKeys: apiKeys.map(({ createdAt, revokedAt, ...key }) => ({
        ...key,
        name: key.name ?? "Unnamed API key",
        createdAt: dayjs(createdAt).toISOString(),
        revokedAt: revokedAt ? dayjs(revokedAt).toISOString() : null,
      })),
      member,
      organization: directory.organization,
      roles: directory.roles,
      self: directory.actorUserId === member.userId,
      teams: directory.teams,
    }
  }
)

export async function saveMemberAssignments(
  orgSlug: string,
  memberId: string,
  input: {
    roleIds: string[]
    teamIds: string[]
    previousRoleIds: string[]
    previousTeamIds: string[]
  }
) {
  const actor = await superadminActor(orgSlug)
  if (!actor) return { error: "forbidden" as const }

  const roleIds = [...new Set(input.roleIds)].sort()
  const teamIds = [...new Set(input.teamIds)].sort()
  if (roleIds.length + teamIds.length === 0) return { error: "assignment-required" as const }

  return preserveActiveSuperadmin(() =>
    getDB().transaction(async (tx) => {
      const authorized = await lockOrganizationForSuperadmin(
        tx,
        actor.organization.id,
        actor.userId
      )
      if (!authorized) return { error: "forbidden" as const }

      const [member] = await tx
        .select({ id: schema.members.id, userId: schema.members.userId })
        .from(schema.members)
        .where(
          and(
            eq(schema.members.id, memberId),
            eq(schema.members.organizationId, actor.organization.id),
            isNull(schema.members.disabledAt)
          )
        )
        .for("update")
        .limit(1)
      if (!member) return { error: "not-found" as const }

      const roles = roleIds.length
        ? await tx
            .select({
              id: schema.roleScopes.roleId,
              systemRole: schema.roleScopes.systemRole,
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
                eq(schema.roleScopes.organizationId, actor.organization.id),
                inArray(schema.roleScopes.roleId, roleIds),
                or(isNull(schema.roleScopes.workspaceId), isNull(schema.workspaces.deletedAt))
              )
            )
        : []
      const teams = teamIds.length
        ? await tx
            .select({ id: schema.teams.id })
            .from(schema.teams)
            .where(
              and(
                eq(schema.teams.organizationId, actor.organization.id),
                inArray(schema.teams.id, teamIds)
              )
            )
        : []
      const currentRoles = await tx
        .select({ roleId: schema.memberRoles.roleId })
        .from(schema.memberRoles)
        .innerJoin(
          schema.roleScopes,
          and(
            eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
            eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
          )
        )
        .where(
          and(
            eq(schema.memberRoles.memberId, member.id),
            eq(schema.memberRoles.organizationId, actor.organization.id)
          )
        )
      const currentTeams = await tx
        .select({ teamId: schema.teamMembers.teamId })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(
          and(
            eq(schema.teamMembers.userId, member.userId),
            eq(schema.teams.organizationId, actor.organization.id)
          )
        )
      if (roles.length !== roleIds.length || teams.length !== teamIds.length) {
        return { error: "invalid" as const }
      }

      const currentRoleIds = currentRoles.map(({ roleId }) => roleId).sort()
      const currentTeamIds = currentTeams.map(({ teamId }) => teamId).sort()
      if (
        currentRoleIds.join("\0") !== [...new Set(input.previousRoleIds)].sort().join("\0") ||
        currentTeamIds.join("\0") !== [...new Set(input.previousTeamIds)].sort().join("\0")
      ) {
        return { error: "stale" as const }
      }

      const removedRoleIds = currentRoleIds.filter((roleId) => !roleIds.includes(roleId))
      const addedRoleIds = roleIds.filter((roleId) => !currentRoleIds.includes(roleId))
      const removedTeamIds = currentTeamIds.filter((teamId) => !teamIds.includes(teamId))
      const addedTeamIds = teamIds.filter((teamId) => !currentTeamIds.includes(teamId))
      if (removedTeamIds.length) {
        const activeTeams = await tx
          .select({
            activeMembers: count(),
            name: schema.teams.name,
            teamId: schema.teams.id,
          })
          .from(schema.teams)
          .innerJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teams.id))
          .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
          .where(
            and(
              eq(schema.teams.organizationId, actor.organization.id),
              eq(schema.members.organizationId, actor.organization.id),
              inArray(schema.teams.id, removedTeamIds),
              isNull(schema.members.disabledAt)
            )
          )
          .groupBy(schema.teams.id, schema.teams.name)
        const finalTeams = activeTeams.filter(({ activeMembers }) => activeMembers === 1)
        if (finalTeams.length) {
          return {
            error: "final-team-member" as const,
            teams: finalTeams.map(({ name }) => name),
          }
        }
      }

      if (removedRoleIds.length) {
        await tx
          .delete(schema.memberRoles)
          .where(
            and(
              eq(schema.memberRoles.memberId, member.id),
              eq(schema.memberRoles.organizationId, actor.organization.id),
              inArray(schema.memberRoles.roleId, removedRoleIds)
            )
          )
      }
      if (addedRoleIds.length) {
        await tx.insert(schema.memberRoles).values(
          addedRoleIds.map((roleId) => ({
            memberId: member.id,
            organizationId: actor.organization.id,
            roleId,
          }))
        )
      }
      if (removedTeamIds.length) {
        await tx
          .delete(schema.teamMembers)
          .where(
            and(
              eq(schema.teamMembers.userId, member.userId),
              inArray(schema.teamMembers.teamId, removedTeamIds)
            )
          )
      }
      if (addedTeamIds.length) {
        await tx
          .insert(schema.teamMembers)
          .values(
            addedTeamIds.map((teamId) => ({ id: randomUUID(), teamId, userId: member.userId }))
          )
      }
      const affectedTeamIds = [...removedTeamIds, ...addedTeamIds]
      if (affectedTeamIds.length) {
        await tx
          .update(schema.teams)
          .set({ updatedAt: dayjs().toDate() })
          .where(
            and(
              eq(schema.teams.organizationId, actor.organization.id),
              inArray(schema.teams.id, affectedTeamIds)
            )
          )
      }
      await assertActiveSuperadmin(tx, actor.organization.id)
      await projectMemberRoleTransports(tx, actor.organization.id, [member.id])
      await tx.insert(schema.eventTrailEvents).values({
        action: "membership.assign",
        actorId: actor.userId,
        actorType: "user",
        after: [
          ...roleIds.map((roleId) => ({ field: "role" as const, value: `Role · ${roleId}` })),
          ...teamIds.map((teamId) => ({ field: "role" as const, value: `Team · ${teamId}` })),
        ],
        before: [
          ...currentRoleIds.map((roleId) => ({
            field: "role" as const,
            value: `Role · ${roleId}`,
          })),
          ...currentTeamIds.map((teamId) => ({
            field: "role" as const,
            value: `Team · ${teamId}`,
          })),
        ],
        category: "membership",
        id: `event-trail-${randomUUID()}`,
        organizationId: actor.organization.id,
        result: "succeeded",
        targetId: member.id,
        targetType: "organization_membership",
      })
      return {
        memberId: member.id,
        organizationId: actor.organization.id,
        roleIds: [...new Set([...currentRoleIds, ...roleIds])],
        teamIds: [...new Set([...currentTeamIds, ...teamIds])],
      }
    })
  )
}

type InvitationAccess = { roleIds: string[]; teamIds: string[] }

export async function createInvitation(orgSlug: string, input: InvitationAccess) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  const roleIds = [...new Set(input.roleIds)]
  const teamIds = [...new Set(input.teamIds)]
  if (roleIds.length + teamIds.length === 0) {
    return { error: "invalid" as const }
  }

  const id = generateId()
  const token = generateId()
  const tokenHash = createHash("sha256").update(token).digest("hex")
  return getDB().transaction(async (tx) => {
    const authorized = await lockOrganizationForSuperadmin(tx, actor.organization.id, actor.userId)
    if (!authorized) return { error: "forbidden" as const }

    const roles = roleIds.length
      ? await tx
          .select({ id: schema.roleScopes.roleId })
          .from(schema.roleScopes)
          .where(
            and(
              eq(schema.roleScopes.organizationId, actor.organization.id),
              inArray(schema.roleScopes.roleId, roleIds)
            )
          )
      : []
    const teams = teamIds.length
      ? await tx
          .select({ id: schema.teams.id })
          .from(schema.teams)
          .where(
            and(
              eq(schema.teams.organizationId, actor.organization.id),
              inArray(schema.teams.id, teamIds)
            )
          )
      : []
    if (roles.length !== roleIds.length || teams.length !== teamIds.length) {
      return { error: "invalid" as const }
    }

    const now = dayjs()
    await tx.insert(schema.organizationInvitations).values({
      id,
      organizationId: actor.organization.id,
      tokenHash,
      expiresAt: now.add(invitationExpiresIn, "millisecond").toDate(),
      inviterId: actor.userId,
      createdAt: now.toDate(),
    })
    if (roleIds.length) {
      await tx.insert(schema.invitationRoles).values(
        roleIds.map((roleId) => ({
          invitationId: id,
          organizationId: actor.organization.id,
          roleId,
        }))
      )
    }
    if (teamIds.length) {
      await tx.insert(schema.invitationTeams).values(
        teamIds.map((teamId) => ({
          invitationId: id,
          organizationId: actor.organization.id,
          teamId,
        }))
      )
    }
    await tx.insert(schema.eventTrailEvents).values({
      action: "invitation.create",
      actorId: actor.userId,
      actorType: "user",
      after: [{ field: "role", value: `${roleIds.length} Roles, ${teamIds.length} Teams` }],
      category: "membership",
      id: `event-trail-${randomUUID()}`,
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: id,
      targetType: "organization_membership",
    })
    return { token }
  })
}

export async function cancelInvitation(orgSlug: string, invitationId: string) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  return getDB().transaction(async (tx) => {
    const authorized = await lockOrganizationForSuperadmin(tx, actor.organization.id, actor.userId)
    if (!authorized) return { error: "forbidden" as const }

    await tx
      .update(schema.organizationInvitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(schema.organizationInvitations.id, invitationId),
          eq(schema.organizationInvitations.organizationId, actor.organization.id),
          eq(schema.organizationInvitations.status, "pending")
        )
      )
    return {}
  })
}

export async function restoreMembership(orgSlug: string, memberId: string) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  return getDB().transaction(async (tx) => {
    const authorized = await lockOrganizationForSuperadmin(tx, actor.organization.id, actor.userId)
    if (!authorized) return { error: "forbidden" as const }

    const [member] = await tx
      .select({
        disabledAt: schema.members.disabledAt,
        id: schema.members.id,
        userId: schema.members.userId,
      })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, actor.organization.id),
          eq(schema.members.id, memberId)
        )
      )
      .for("update")
      .limit(1)
    if (!member) {
      return { error: "not-found" as const }
    }
    if (!member.disabledAt) {
      return { error: "already-active" as const }
    }

    const roles = await tx
      .select({ id: schema.memberRoles.roleId })
      .from(schema.memberRoles)
      .where(
        and(
          eq(schema.memberRoles.memberId, member.id),
          eq(schema.memberRoles.organizationId, actor.organization.id)
        )
      )
      .limit(1)
    const teams = await tx
      .select({ id: schema.teamMembers.teamId })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(
        and(
          eq(schema.teamMembers.userId, member.userId),
          eq(schema.teams.organizationId, actor.organization.id)
        )
      )
      .limit(1)
    if (roles.length + teams.length === 0) return { error: "assignment-required" as const }

    await tx
      .update(schema.members)
      .set({ disabledAt: null })
      .where(
        and(
          eq(schema.members.organizationId, actor.organization.id),
          eq(schema.members.id, member.id)
        )
      )
    await tx.insert(schema.eventTrailEvents).values({
      action: "membership.restore",
      actorId: actor.userId,
      actorType: "user",
      after: [{ field: "state", value: "active" }],
      category: "membership",
      id: `event-trail-${randomUUID()}`,
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: member.id,
      targetType: "organization_membership",
    })
    return {}
  })
}

export async function removeMembership(
  orgSlug: string,
  memberId: string,
  operation: "membership_disable" | "membership_remove",
  confirmation: string,
  fingerprint: string
) {
  const actor = await superadminActor(orgSlug)
  if (!actor) return { error: "forbidden" as const }
  const target: DestructiveTarget = {
    operation,
    targetId: memberId,
    targetType: "organization_membership",
  }

  return getDB().transaction(async (tx) => {
    const authorized = await lockOrganizationForSuperadmin(tx, actor.organization.id, actor.userId)
    if (!authorized) return { error: "forbidden" as const }

    const [member] = await tx
      .select({
        disabledAt: schema.members.disabledAt,
        id: schema.members.id,
        userId: schema.members.userId,
      })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.id, memberId),
          eq(schema.members.organizationId, actor.organization.id)
        )
      )
      .for("update")
      .limit(1)
    if (!member) return { error: "not-found" as const }
    if (member.userId === actor.userId) return { error: "self-removal" as const }
    if (operation === "membership_disable" && member.disabledAt) {
      return { error: "already-disabled" as const }
    }

    const ownedAgents = await tx
      .select({
        agentName: schema.agentOwners.agentName,
        workspaceId: schema.agentOwners.workspaceId,
      })
      .from(schema.agentOwners)
      .where(
        and(
          eq(schema.agentOwners.organizationId, actor.organization.id),
          eq(schema.agentOwners.ownerUserId, member.userId)
        )
      )
      .orderBy(asc(schema.agentOwners.workspaceId), asc(schema.agentOwners.agentName))
      .for("update")

    const impact = await analyzeDestructiveImpact(
      tx,
      actor.organization.id,
      actor.organization.slug,
      target
    )
    if (!impact) return { error: "not-found" as const }
    if (impact.confirmation !== confirmation || impact.fingerprint !== fingerprint) {
      return { error: "stale-preview" as const }
    }

    const [superadmin] = await tx
      .select({ memberId: schema.memberRoleAssignments.memberId })
      .from(schema.memberRoleAssignments)
      .innerJoin(
        schema.roleScopes,
        and(
          eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
          eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
        )
      )
      .where(
        and(
          eq(schema.memberRoleAssignments.organizationId, actor.organization.id),
          eq(schema.memberRoleAssignments.memberId, member.id),
          eq(schema.roleScopes.systemRole, "superadmin")
        )
      )
      .limit(1)
    if (superadmin && !member.disabledAt) {
      const [superadminCount] = await tx
        .select({ activeSuperadmins: countDistinct(schema.memberRoleAssignments.memberId) })
        .from(schema.memberRoleAssignments)
        .innerJoin(
          schema.members,
          and(
            eq(schema.memberRoleAssignments.memberId, schema.members.id),
            eq(schema.memberRoleAssignments.organizationId, schema.members.organizationId)
          )
        )
        .innerJoin(
          schema.roleScopes,
          and(
            eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
            eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
          )
        )
        .where(
          and(
            eq(schema.members.organizationId, actor.organization.id),
            isNull(schema.members.disabledAt),
            eq(schema.roleScopes.systemRole, "superadmin")
          )
        )
      if (!superadminCount) {
        throw new Error("active Superadmin count query returned no row")
      }
      const { activeSuperadmins } = superadminCount
      if (activeSuperadmins === 1) return { error: "final-superadmin" as const }
    }

    const teams = await tx
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(
        and(
          eq(schema.teamMembers.userId, member.userId),
          eq(schema.teams.organizationId, actor.organization.id)
        )
      )
      .orderBy(asc(schema.teams.name))
    if (!member.disabledAt && teams.length) {
      const activeTeams = await tx
        .select({ activeMembers: count(), teamId: schema.teamMembers.teamId })
        .from(schema.teamMembers)
        .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
        .where(
          and(
            inArray(
              schema.teamMembers.teamId,
              teams.map((team) => team.id)
            ),
            eq(schema.members.organizationId, actor.organization.id),
            isNull(schema.members.disabledAt)
          )
        )
        .groupBy(schema.teamMembers.teamId)
      const counts = new Map(activeTeams.map((team) => [team.teamId, team.activeMembers]))
      const finalTeams = teams.filter((team) => (counts.get(team.id) ?? 0) <= 1)
      if (finalTeams.length) {
        return { error: "final-team-member" as const, teams: finalTeams.map((team) => team.name) }
      }
    }

    const now = dayjs().toDate()
    const impactedKeys = await tx
      .selectDistinct({ id: schema.apiKeyScopes.apiKeyId })
      .from(schema.apiKeyScopes)
      .innerJoin(
        schema.apiKeyTargets,
        eq(schema.apiKeyTargets.apiKeyId, schema.apiKeyScopes.apiKeyId)
      )
      .where(
        and(
          eq(schema.apiKeyScopes.organizationId, actor.organization.id),
          isNull(schema.apiKeyScopes.revokedAt),
          or(
            eq(schema.apiKeyScopes.creatorUserId, member.userId),
            exists(
              tx
                .select({ ownerUserId: schema.agentOwners.ownerUserId })
                .from(schema.agentOwners)
                .where(
                  and(
                    eq(schema.agentOwners.organizationId, actor.organization.id),
                    eq(schema.agentOwners.ownerUserId, member.userId),
                    eq(schema.agentOwners.workspaceId, schema.apiKeyScopes.workspaceId),
                    eq(schema.agentOwners.agentName, schema.apiKeyTargets.agentName)
                  )
                )
            )
          )
        )
      )
    const revokedKeys = impactedKeys.length
      ? await tx
          .update(schema.apiKeyScopes)
          .set({
            revokedAt: now,
            revokedReason:
              operation === "membership_remove"
                ? "Organisation Membership removed or an owned Agent target deleted."
                : "Organisation Membership disabled or an owned Agent target deleted.",
          })
          .where(
            and(
              eq(schema.apiKeyScopes.organizationId, actor.organization.id),
              inArray(
                schema.apiKeyScopes.apiKeyId,
                impactedKeys.map((key) => key.id)
              ),
              isNull(schema.apiKeyScopes.revokedAt)
            )
          )
          .returning({ id: schema.apiKeyScopes.apiKeyId })
      : []
    if (revokedKeys.length) {
      await tx
        .update(schema.apikeys)
        .set({ enabled: false, updatedAt: now })
        .where(
          and(
            eq(schema.apikeys.referenceId, actor.organization.id),
            inArray(
              schema.apikeys.id,
              revokedKeys.map((key) => key.id)
            )
          )
        )
    }
    await tx
      .delete(schema.agentShares)
      .where(
        and(
          eq(schema.agentShares.organizationId, actor.organization.id),
          eq(schema.agentShares.targetUserId, member.userId)
        )
      )
    await tx
      .delete(schema.agentOwners)
      .where(
        and(
          eq(schema.agentOwners.organizationId, actor.organization.id),
          eq(schema.agentOwners.ownerUserId, member.userId)
        )
      )

    if (operation === "membership_remove") {
      if (teams.length) {
        await tx.delete(schema.teamMembers).where(
          and(
            eq(schema.teamMembers.userId, member.userId),
            inArray(
              schema.teamMembers.teamId,
              teams.map((team) => team.id)
            )
          )
        )
      }
      await tx
        .delete(schema.members)
        .where(
          and(
            eq(schema.members.id, member.id),
            eq(schema.members.organizationId, actor.organization.id)
          )
        )
    } else {
      await tx
        .update(schema.members)
        .set({ disabledAt: now })
        .where(
          and(
            eq(schema.members.id, member.id),
            eq(schema.members.organizationId, actor.organization.id)
          )
        )
    }

    const cleanupId = `cleanup-${randomUUID()}`
    await tx.insert(schema.cleanupJobs).values({
      id: cleanupId,
      operation,
      organizationId: actor.organization.id,
      payload: {
        api_key_count: revokedKeys.length,
        member_id: member.id,
        operation,
        owned_agent_count: ownedAgents.length,
        owned_agents: ownedAgents.map((agent) => ({
          agent_name: agent.agentName,
          workspace_id: agent.workspaceId,
        })),
        revokes_authorization_first: true,
        user_id: member.userId,
      },
      targetId: member.id,
      targetType: "organization_membership",
    })
    await tx.insert(schema.eventTrailEvents).values({
      action: operation === "membership_remove" ? "membership.remove" : "membership.disable",
      actorId: actor.userId,
      actorType: "user",
      after: [
        { field: "state", value: operation === "membership_remove" ? "removed" : "disabled" },
        { field: "role", value: `${revokedKeys.length} API keys revoked` },
        { field: "name", value: `${ownedAgents.length} owned Agents queued` },
      ],
      category: "membership",
      id: `event-trail-${randomUUID()}`,
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: member.id,
      targetType: "organization_membership",
    })
    return { cleanupId }
  })
}

export async function getSocialAdmission(orgSlug: string): Promise<SocialAdmission | undefined> {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return
  }

  const db = getDB()
  const [
    policy,
    googleDomains,
    githubRules,
    roleRows,
    teamRows,
    defaultRoles,
    defaultTeams,
    workspaces,
    workspaceGrants,
    teamRoles,
  ] = await Promise.all([
    db
      .select({
        enabled: schema.socialAdmissionPolicies.enabled,
        githubEnabled: schema.socialAdmissionPolicies.githubEnabled,
        googleEnabled: schema.socialAdmissionPolicies.googleEnabled,
      })
      .from(schema.socialAdmissionPolicies)
      .where(eq(schema.socialAdmissionPolicies.organizationId, actor.organization.id))
      .limit(1),
    db
      .select({ domain: schema.socialAdmissionGoogleDomains.domain })
      .from(schema.socialAdmissionGoogleDomains)
      .where(eq(schema.socialAdmissionGoogleDomains.organizationId, actor.organization.id))
      .orderBy(asc(schema.socialAdmissionGoogleDomains.domain)),
    db
      .select({
        id: schema.socialAdmissionGithubRules.id,
        organization: schema.socialAdmissionGithubRules.githubOrganization,
        team: schema.socialAdmissionGithubRules.githubTeam,
      })
      .from(schema.socialAdmissionGithubRules)
      .where(eq(schema.socialAdmissionGithubRules.organizationId, actor.organization.id))
      .orderBy(asc(schema.socialAdmissionGithubRules.githubOrganization)),
    db
      .select({
        id: schema.roleScopes.roleId,
        name: schema.roleScopes.displayName,
        systemRole: schema.roleScopes.systemRole,
        workspaceId: schema.roleScopes.workspaceId,
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
      .where(eq(schema.roleScopes.organizationId, actor.organization.id))
      .orderBy(
        sql`${schema.workspaces.name} ASC NULLS FIRST`,
        asc(schema.roleScopes.displayName),
        asc(schema.roleScopes.roleId)
      ),
    db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.organizationId, actor.organization.id))
      .orderBy(asc(schema.teams.name)),
    db
      .select({ id: schema.socialAdmissionDefaultRoles.roleId })
      .from(schema.socialAdmissionDefaultRoles)
      .where(eq(schema.socialAdmissionDefaultRoles.organizationId, actor.organization.id)),
    db
      .select({ id: schema.socialAdmissionDefaultTeams.teamId })
      .from(schema.socialAdmissionDefaultTeams)
      .where(eq(schema.socialAdmissionDefaultTeams.organizationId, actor.organization.id)),
    db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.organizationId, actor.organization.id),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .orderBy(asc(schema.workspaces.name)),
    db
      .select({
        roleId: schema.permissionGrants.roleId,
        workspaceId: schema.permissionGrants.workspaceId,
      })
      .from(schema.permissionGrants)
      .where(
        and(
          eq(schema.permissionGrants.organizationId, actor.organization.id),
          sql`${schema.permissionGrants.workspaceId} IS NOT NULL`
        )
      ),
    db
      .select({ roleId: schema.teamRoles.roleId, teamId: schema.teamRoles.teamId })
      .from(schema.teamRoles)
      .where(eq(schema.teamRoles.organizationId, actor.organization.id)),
  ])

  const allWorkspaceIds = workspaces.map((workspace) => workspace.id)
  const roleWorkspaceIds = new Map<string, Set<string>>()
  for (const role of roleRows) {
    const ids = new Set<string>()
    if (role.systemRole === "superadmin") {
      allWorkspaceIds.forEach((id) => ids.add(id))
    }
    if (role.workspaceId) ids.add(role.workspaceId)
    roleWorkspaceIds.set(role.id, ids)
  }
  for (const grant of workspaceGrants) {
    if (grant.workspaceId) roleWorkspaceIds.get(grant.roleId)?.add(grant.workspaceId)
  }
  const roles = roleRows.map((role) => ({
    id: role.id,
    name: role.name,
    scope: role.workspace === null ? "Organisation" : `Workspace · ${role.workspace}`,
    workspace: role.workspace,
    workspaceIds: [...(roleWorkspaceIds.get(role.id) ?? [])].sort(),
  }))
  const teams = teamRows.map((team) => {
    const workspaceIds = new Set<string>()
    for (const assignment of teamRoles) {
      if (assignment.teamId !== team.id) continue
      roleWorkspaceIds.get(assignment.roleId)?.forEach((id) => workspaceIds.add(id))
    }
    return { ...team, workspaceIds: [...workspaceIds].sort() }
  })

  const env = getEnv()
  return {
    defaultRoleIds: defaultRoles.map((role) => role.id),
    defaultTeamIds: defaultTeams.map((team) => team.id),
    enabled: policy[0]?.enabled ?? false,
    githubConfigured: env.GITHUB_CLIENT_ID !== undefined,
    githubEnabled: policy[0]?.githubEnabled ?? false,
    githubRules,
    googleConfigured: env.GOOGLE_CLIENT_ID !== undefined,
    googleEnabled: policy[0]?.googleEnabled ?? false,
    googleDomains: googleDomains.map((row) => row.domain),
    joinLink: `${env.BETTER_AUTH_URL}/join/${actor.organization.slug}`,
    organization: actor.organization,
    roles,
    teams,
    workspaces,
  }
}

export async function saveSocialAdmission(
  orgSlug: string,
  input: {
    enabled: boolean
    googleEnabled: boolean
    githubEnabled: boolean
    roleIds: string[]
    teamIds: string[]
    googleDomains: string[]
    githubRules: { organization: string; team?: string }[]
  }
) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  const roleIds = [...new Set(input.roleIds)]
  const teamIds = [...new Set(input.teamIds)]
  if (input.enabled && roleIds.length + teamIds.length === 0) {
    return { error: "default-access-required" as const }
  }
  if (input.enabled && !input.googleEnabled && !input.githubEnabled) {
    return { error: "provider-required" as const }
  }

  const domains = [
    ...new Set(input.googleDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)),
  ]
  const githubRules = input.githubRules
    .map((rule) => ({
      organization: rule.organization.trim(),
      team: rule.team?.trim() || undefined,
    }))
    .filter((rule) => rule.organization)

  if (input.enabled && input.googleEnabled && domains.length === 0) {
    return { error: "google-rule-required" as const }
  }
  if (input.enabled && input.githubEnabled && githubRules.length === 0) {
    return { error: "github-rule-required" as const }
  }

  const env = getEnv()
  if (input.enabled && input.googleEnabled && !env.GOOGLE_CLIENT_ID) {
    return { error: "google-unavailable" as const }
  }
  if (input.enabled && input.githubEnabled && !env.GITHUB_CLIENT_ID) {
    return { error: "github-unavailable" as const }
  }

  return getDB().transaction(async (tx) => {
    const authorized = await lockOrganizationForSuperadmin(tx, actor.organization.id, actor.userId)
    if (!authorized) {
      return { error: "forbidden" as const }
    }

    const roles = roleIds.length
      ? await tx
          .select({ id: schema.roleScopes.roleId })
          .from(schema.roleScopes)
          .where(
            and(
              eq(schema.roleScopes.organizationId, actor.organization.id),
              inArray(schema.roleScopes.roleId, roleIds)
            )
          )
      : []
    const teams = teamIds.length
      ? await tx
          .select({ id: schema.teams.id })
          .from(schema.teams)
          .where(
            and(
              eq(schema.teams.organizationId, actor.organization.id),
              inArray(schema.teams.id, teamIds)
            )
          )
      : []
    if (roles.length !== roleIds.length || teams.length !== teamIds.length) {
      return { error: "invalid-assignment" as const }
    }

    await tx
      .insert(schema.socialAdmissionPolicies)
      .values({
        enabled: input.enabled,
        githubEnabled: input.githubEnabled,
        googleEnabled: input.googleEnabled,
        organizationId: actor.organization.id,
      })
      .onConflictDoUpdate({
        target: schema.socialAdmissionPolicies.organizationId,
        set: {
          enabled: input.enabled,
          githubEnabled: input.githubEnabled,
          googleEnabled: input.googleEnabled,
          updatedAt: dayjs().toDate(),
        },
      })
    await tx
      .delete(schema.socialAdmissionGoogleDomains)
      .where(eq(schema.socialAdmissionGoogleDomains.organizationId, actor.organization.id))
    await tx
      .delete(schema.socialAdmissionGithubRules)
      .where(eq(schema.socialAdmissionGithubRules.organizationId, actor.organization.id))
    await tx
      .delete(schema.socialAdmissionDefaultRoles)
      .where(eq(schema.socialAdmissionDefaultRoles.organizationId, actor.organization.id))
    await tx
      .delete(schema.socialAdmissionDefaultTeams)
      .where(eq(schema.socialAdmissionDefaultTeams.organizationId, actor.organization.id))

    if (domains.length) {
      await tx
        .insert(schema.socialAdmissionGoogleDomains)
        .values(domains.map((domain) => ({ domain, organizationId: actor.organization.id })))
    }
    if (githubRules.length) {
      await tx.insert(schema.socialAdmissionGithubRules).values(
        githubRules.map((rule) => ({
          githubOrganization: rule.organization,
          githubTeam: rule.team,
          id: `github-rule-${randomUUID()}`,
          organizationId: actor.organization.id,
        }))
      )
    }
    if (roleIds.length) {
      await tx
        .insert(schema.socialAdmissionDefaultRoles)
        .values(roleIds.map((roleId) => ({ organizationId: actor.organization.id, roleId })))
    }
    if (teamIds.length) {
      await tx.insert(schema.socialAdmissionDefaultTeams).values(
        teamIds.map((teamId) => ({
          organizationId: actor.organization.id,
          teamId,
        }))
      )
    }
    await tx.insert(schema.eventTrailEvents).values({
      action: "social_admission.update",
      actorId: actor.userId,
      actorType: "user",
      after: [
        { field: "state", value: input.enabled ? "enabled" : "disabled" },
        {
          field: "name",
          value:
            input.googleEnabled && input.githubEnabled
              ? "Google, GitHub"
              : input.googleEnabled
                ? "Google"
                : input.githubEnabled
                  ? "GitHub"
                  : "None",
        },
        { field: "role", value: `${roleIds.length} default Roles` },
      ],
      category: "membership",
      id: `event-trail-${randomUUID()}`,
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: actor.organization.id,
      targetType: "organization",
    })
    return {}
  })
}

export async function acceptInvitation(token: string) {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) {
    return { error: "unauthorized" as const }
  }

  const result = await getAuth().api.acceptOrganizationInvitation({
    headers: requestHeaders,
    body: { token },
  })
  if (result.kind === "accepted" || result.kind === "member") {
    return { slug: result.slug }
  }
  return { error: result.kind }
}

export async function getInvitationAcceptance(token: string) {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) {
    return { kind: "unauthorized" as const }
  }

  const tokenHash = createHash("sha256").update(token).digest("hex")
  const [invitation] = await getDB()
    .select({
      expiresAt: schema.organizationInvitations.expiresAt,
      inviterName: schema.users.name,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationSlug: schema.organizations.slug,
      status: schema.organizationInvitations.status,
    })
    .from(schema.organizationInvitations)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationInvitations.organizationId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationInvitations.inviterId))
    .where(eq(schema.organizationInvitations.tokenHash, tokenHash))
    .limit(1)

  if (
    !invitation ||
    invitation.status !== "pending" ||
    !dayjs(invitation.expiresAt).isAfter(dayjs())
  ) {
    return { kind: "unavailable" as const }
  }

  const [membership] = await getDB()
    .select({ disabledAt: schema.members.disabledAt })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.organizationId, invitation.organizationId),
        eq(schema.members.userId, session.user.id)
      )
    )
    .limit(1)
  if (membership && !membership.disabledAt) {
    return { kind: "member" as const, slug: invitation.organizationSlug }
  }
  if (membership) {
    return { kind: "disabled" as const }
  }

  return {
    kind: "ready" as const,
    inviterName: invitation.inviterName,
    organizationName: invitation.organizationName,
  }
}
