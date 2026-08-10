import "server-only"

import { randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import { APIError } from "@better-auth/core/error"
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getOrganizationSession, resolveOrganizationSlug } from "@/data/organizations"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"

export type MemberTab = "active" | "invited" | "disabled"

export type MemberDirectory = {
  organization: { id: string; name: string; slug: string }
  active: ActiveMember[]
  disabled: ActiveMember[]
  invited: InvitationRow[]
  roles: AssignmentOption[]
  teams: AssignmentOption[]
}

export type ActiveMember = {
  id: string
  userId: string
  name: string
  email: string
  createdAt: string
  disabledAt: string | null
  roles: string[]
  teams: string[]
  ownedAgents: number
  apiKeys: number
  lastActivity: string | null
  superadmin: boolean
}

export type InvitationRow = {
  id: string
  email: string
  expiresAt: string
  createdAt: string
  inviter: string
  roles: string[]
  teams: string[]
  roleIds: string[]
  teamIds: string[]
  link: string
  expired: boolean
}

export type AssignmentOption = { id: string; name: string }

export type SocialAdmission = {
  organization: { id: string; name: string; slug: string }
  enabled: boolean
  googleDomains: string[]
  githubRules: { id: string; organization: string; team: string | null }[]
  roles: AssignmentOption[]
  teams: AssignmentOption[]
  defaultRoleIds: string[]
  defaultTeamIds: string[]
  joinLinks: { google: string; github: string }
}

type Actor = {
  headers: Headers
  organization: { id: string; name: string; slug: string }
  userId: string
}

async function superadminActor(orgSlug: string): Promise<Actor | undefined> {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return
  }

  return {
    headers: result.organizationSession.requestHeaders,
    organization: result.organization,
    userId: result.organizationSession.session.user.id,
  }
}

export async function getMemberDirectory(orgSlug: string): Promise<MemberDirectory | undefined> {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return
  }

  const db = getDB()
  const [members, invitations, roleRows, teamRows] = await Promise.all([
    db
      .select({
        id: schema.members.id,
        userId: schema.members.userId,
        name: schema.users.name,
        email: schema.users.email,
        createdAt: schema.members.createdAt,
        disabledAt: schema.members.disabledAt,
        lastActivity: sql<Date | null>`(
          SELECT max(${schema.sessions.updatedAt})
          FROM ${schema.sessions}
          WHERE ${schema.sessions.userId} = ${schema.members.userId}
        )`,
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
      })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.organizationId, actor.organization.id))
      .orderBy(asc(schema.users.name), asc(schema.users.email)),
    db
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        expiresAt: schema.invitations.expiresAt,
        createdAt: schema.invitations.createdAt,
        inviter: schema.users.email,
      })
      .from(schema.invitations)
      .innerJoin(schema.users, eq(schema.users.id, schema.invitations.inviterId))
      .where(
        and(
          eq(schema.invitations.organizationId, actor.organization.id),
          eq(schema.invitations.status, "pending")
        )
      )
      .orderBy(desc(schema.invitations.createdAt), desc(schema.invitations.id)),
    db
      .select({ id: schema.roleScopes.roleId, name: schema.roleScopes.displayName })
      .from(schema.roleScopes)
      .where(eq(schema.roleScopes.organizationId, actor.organization.id))
      .orderBy(asc(schema.roleScopes.displayName), asc(schema.roleScopes.roleId)),
    db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.organizationId, actor.organization.id))
      .orderBy(asc(schema.teams.name), asc(schema.teams.id)),
  ])

  const memberIds = members.map((member) => member.id)
  const userIds = members.map((member) => member.userId)
  const invitationIds = invitations.map((invitation) => invitation.id)
  const [memberRoles, memberTeams, invitationRoles, invitationTeams] = await Promise.all([
    memberIds.length
      ? db
          .select({
            memberId: schema.memberRoles.memberId,
            name: schema.roleScopes.displayName,
            systemRole: schema.roleScopes.systemRole,
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
          .select({ userId: schema.teamMembers.userId, name: schema.teams.name })
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
            roleId: schema.invitationRoles.roleId,
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
            teamId: schema.invitationTeams.teamId,
          })
          .from(schema.invitationTeams)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.invitationTeams.teamId))
          .where(inArray(schema.invitationTeams.invitationId, invitationIds))
      : [],
  ])

  const rolesByMember = new Map<string, string[]>()
  const superadminMembers = new Set<string>()
  for (const role of memberRoles) {
    rolesByMember.set(role.memberId, [...(rolesByMember.get(role.memberId) ?? []), role.name])
    if (role.systemRole === "superadmin") {
      superadminMembers.add(role.memberId)
    }
  }

  const teamsByUser = new Map<string, string[]>()
  for (const team of memberTeams) {
    teamsByUser.set(team.userId, [...(teamsByUser.get(team.userId) ?? []), team.name])
  }

  const rolesByInvitation = new Map<string, string[]>()
  const roleIdsByInvitation = new Map<string, string[]>()
  for (const role of invitationRoles) {
    rolesByInvitation.set(role.invitationId, [
      ...(rolesByInvitation.get(role.invitationId) ?? []),
      role.name,
    ])
    roleIdsByInvitation.set(role.invitationId, [
      ...(roleIdsByInvitation.get(role.invitationId) ?? []),
      role.roleId,
    ])
  }

  const teamsByInvitation = new Map<string, string[]>()
  const teamIdsByInvitation = new Map<string, string[]>()
  for (const team of invitationTeams) {
    teamsByInvitation.set(team.invitationId, [
      ...(teamsByInvitation.get(team.invitationId) ?? []),
      team.name,
    ])
    teamIdsByInvitation.set(team.invitationId, [
      ...(teamIdsByInvitation.get(team.invitationId) ?? []),
      team.teamId,
    ])
  }

  const active: ActiveMember[] = []
  const disabled: ActiveMember[] = []
  for (const member of members) {
    const row = {
      ...member,
      apiKeys: member.apiKeys,
      createdAt: member.createdAt.toISOString(),
      disabledAt: member.disabledAt?.toISOString() ?? null,
      lastActivity: member.lastActivity?.toISOString() ?? null,
      ownedAgents: member.ownedAgents,
      roles: rolesByMember.get(member.id) ?? [],
      superadmin: superadminMembers.has(member.id),
      teams: teamsByUser.get(member.userId) ?? [],
    }
    if (member.disabledAt) {
      disabled.push(row)
      continue
    }
    active.push(row)
  }

  const baseURL = getEnv().BETTER_AUTH_URL
  const now = Date.now()
  return {
    active,
    disabled,
    invited: invitations.map((invitation) => ({
      ...invitation,
      createdAt: invitation.createdAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
      expiresAt: invitation.expiresAt.toISOString(),
      link: `${baseURL}/accept-invitation/${invitation.id}`,
      roleIds: roleIdsByInvitation.get(invitation.id) ?? [],
      roles: rolesByInvitation.get(invitation.id) ?? [],
      teamIds: teamIdsByInvitation.get(invitation.id) ?? [],
      teams: teamsByInvitation.get(invitation.id) ?? [],
    })),
    organization: actor.organization,
    roles: roleRows,
    teams: teamRows,
  }
}

export async function inviteMember(
  orgSlug: string,
  input: { email: string; roleIds: string[]; teamIds: string[] }
) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  const email = input.email.trim().toLowerCase()
  const roleIds = [...new Set(input.roleIds)]
  const teamIds = [...new Set(input.teamIds)]
  if (!email || roleIds.length + teamIds.length === 0) {
    return { error: "invalid" as const }
  }

  const db = getDB()
  const [roles, teams] = await Promise.all([
    roleIds.length
      ? db
          .select({ id: schema.roleScopes.roleId, role: schema.organizationRoles.role })
          .from(schema.roleScopes)
          .innerJoin(
            schema.organizationRoles,
            and(
              eq(schema.organizationRoles.id, schema.roleScopes.roleId),
              eq(schema.organizationRoles.organizationId, schema.roleScopes.organizationId)
            )
          )
          .where(
            and(
              eq(schema.roleScopes.organizationId, actor.organization.id),
              inArray(schema.roleScopes.roleId, roleIds)
            )
          )
      : [],
    teamIds.length
      ? db
          .select({ id: schema.teams.id })
          .from(schema.teams)
          .where(
            and(
              eq(schema.teams.organizationId, actor.organization.id),
              inArray(schema.teams.id, teamIds)
            )
          )
      : [],
  ])
  if (roles.length !== roleIds.length || teams.length !== teamIds.length) {
    return { error: "invalid" as const }
  }

  let invitation
  try {
    invitation = await getAuth().api.createInvitation({
      headers: actor.headers,
      body: {
        email,
        organizationId: actor.organization.id,
        role: roles.length ? roles.map(({ role }) => role) : "member",
        teamId: teamIds,
      },
    })
  } catch (error) {
    if (error instanceof APIError) {
      if (error.body?.code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") {
        return { error: "already-member" as const }
      }
      return { error: "invalid" as const }
    }
    throw error
  }

  try {
    await db.transaction(async (tx) => {
      if (roleIds.length) {
        await tx.insert(schema.invitationRoles).values(
          roleIds.map((roleId) => ({
            invitationId: invitation.id,
            organizationId: actor.organization.id,
            roleId,
          }))
        )
      }
      if (teamIds.length) {
        await tx.insert(schema.invitationTeams).values(
          teamIds.map((teamId) => ({
            invitationId: invitation.id,
            organizationId: actor.organization.id,
            teamId,
          }))
        )
      }
      await tx.insert(schema.auditEvents).values({
        action: "invitation.create",
        actorId: actor.userId,
        actorType: "user",
        after: [
          { field: "user_id", value: email },
          { field: "role", value: `${roleIds.length} Roles, ${teamIds.length} Teams` },
        ],
        automaticCascade: true,
        category: "membership",
        id: `audit-${randomUUID()}`,
        interface: "web",
        ipAddress: getIp(actor.headers, getAuth().options),
        organizationId: actor.organization.id,
        result: "succeeded",
        targetId: invitation.id,
        targetType: "organization_membership",
        userAgent: actor.headers.get("user-agent"),
      })
    })
  } catch (error) {
    await getAuth().api.cancelInvitation({
      headers: actor.headers,
      body: { invitationId: invitation.id },
    })
    throw error
  }

  return { invitationId: invitation.id }
}

export async function cancelInvitation(orgSlug: string, invitationId: string) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  await getAuth().api.cancelInvitation({
    headers: actor.headers,
    body: { invitationId },
  })
  return {}
}

export async function setMemberDisabled(orgSlug: string, memberId: string, disabled: boolean) {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return { error: "forbidden" as const }
  }

  return getDB().transaction(async (tx) => {
    const [member] = await tx
      .select({ id: schema.members.id, userId: schema.members.userId })
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

    const [superadmin] = await tx
      .select({ memberId: schema.memberRoles.memberId })
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
          eq(schema.memberRoles.memberId, member.id),
          eq(schema.roleScopes.systemRole, "superadmin")
        )
      )
      .limit(1)
    if (disabled && superadmin) {
      const activeSuperadmins = await tx
        .selectDistinct({ memberId: schema.members.id })
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
            eq(schema.members.organizationId, actor.organization.id),
            isNull(schema.members.disabledAt),
            eq(schema.roleScopes.systemRole, "superadmin")
          )
        )
      if (activeSuperadmins.length === 1) {
        return { error: "final-superadmin" as const }
      }
    }

    const now = new Date()
    const ownedAgents = disabled
      ? await tx
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
      : []
    if (ownedAgents.length) {
      await tx
        .delete(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, actor.organization.id),
            eq(schema.agentOwners.ownerUserId, member.userId)
          )
        )
    }

    const revokedAPIKeys = disabled
      ? await tx
          .update(schema.apiKeyScopes)
          .set({
            revokedAt: now,
            revokedReason: "Organisation Membership disabled.",
          })
          .where(
            and(
              eq(schema.apiKeyScopes.organizationId, actor.organization.id),
              eq(schema.apiKeyScopes.creatorUserId, member.userId),
              isNull(schema.apiKeyScopes.revokedAt)
            )
          )
          .returning({ apiKeyId: schema.apiKeyScopes.apiKeyId })
      : []
    if (revokedAPIKeys.length) {
      await tx
        .update(schema.apikeys)
        .set({ enabled: false, updatedAt: now })
        .where(
          and(
            eq(schema.apikeys.referenceId, actor.organization.id),
            inArray(
              schema.apikeys.id,
              revokedAPIKeys.map((key) => key.apiKeyId)
            )
          )
        )
    }

    const cleanupId = disabled ? `cleanup-${randomUUID()}` : undefined
    if (cleanupId) {
      await tx.insert(schema.cleanupJobs).values({
        id: cleanupId,
        operation: "membership_disable",
        organizationId: actor.organization.id,
        payload: {
          api_key_count: revokedAPIKeys.length,
          operation: "membership_disable",
          owned_agent_count: ownedAgents.length,
          owned_agents: ownedAgents.map((agent) => ({
            agent_name: agent.agentName,
            workspace_id: agent.workspaceId,
          })),
          member_id: member.id,
          user_id: member.userId,
          revokes_authorization_first: true,
        },
        targetId: member.id,
        targetType: "organization_membership",
      })
    }
    await tx
      .update(schema.members)
      .set({ disabledAt: disabled ? now : null })
      .where(
        and(
          eq(schema.members.organizationId, actor.organization.id),
          eq(schema.members.id, member.id)
        )
      )
    await tx.insert(schema.auditEvents).values({
      action: disabled ? "membership.disable" : "membership.restore",
      actorId: actor.userId,
      actorType: "user",
      after: [
        { field: "member_id", value: member.id },
        ...(disabled
          ? [{ field: "role" as const, value: `${revokedAPIKeys.length} API keys revoked` }]
          : []),
        ...(disabled
          ? [{ field: "state" as const, value: `${ownedAgents.length} owned Agents queued` }]
          : []),
      ],
      automaticCascade: Boolean(cleanupId),
      category: "membership",
      cleanupJobId: cleanupId,
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(actor.headers, getAuth().options),
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: member.id,
      targetType: "organization_membership",
      userAgent: actor.headers.get("user-agent"),
    })
    return {}
  })
}

export async function getSocialAdmission(orgSlug: string): Promise<SocialAdmission | undefined> {
  const actor = await superadminActor(orgSlug)
  if (!actor) {
    return
  }

  const db = getDB()
  const [policy, googleDomains, githubRules, roles, teams, defaultRoles, defaultTeams] =
    await Promise.all([
      db
        .select({ enabled: schema.socialAdmissionPolicies.enabled })
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
        .select({ id: schema.roleScopes.roleId, name: schema.roleScopes.displayName })
        .from(schema.roleScopes)
        .where(eq(schema.roleScopes.organizationId, actor.organization.id))
        .orderBy(asc(schema.roleScopes.displayName)),
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
    ])

  const root = getEnv().BETTER_AUTH_URL
  return {
    defaultRoleIds: defaultRoles.map((role) => role.id),
    defaultTeamIds: defaultTeams.map((team) => team.id),
    enabled: policy[0]?.enabled ?? false,
    githubRules,
    googleDomains: googleDomains.map((row) => row.domain),
    joinLinks: {
      github: `${root}/join/${actor.organization.slug}/github`,
      google: `${root}/join/${actor.organization.slug}/google`,
    },
    organization: actor.organization,
    roles,
    teams,
  }
}

export async function saveSocialAdmission(
  orgSlug: string,
  input: {
    enabled: boolean
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
  if (input.enabled && roleIds.length === 0) {
    return { error: "default-role-required" as const }
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

  return getDB().transaction(async (tx) => {
    const teamIds = [...new Set(input.teamIds)]
    const [roles, teams] = await Promise.all([
      roleIds.length
        ? tx
            .select({ id: schema.roleScopes.roleId })
            .from(schema.roleScopes)
            .where(
              and(
                eq(schema.roleScopes.organizationId, actor.organization.id),
                inArray(schema.roleScopes.roleId, roleIds)
              )
            )
        : [],
      teamIds.length
        ? tx
            .select({ id: schema.teams.id })
            .from(schema.teams)
            .where(
              and(
                eq(schema.teams.organizationId, actor.organization.id),
                inArray(schema.teams.id, teamIds)
              )
            )
        : [],
    ])
    if (roles.length !== roleIds.length || teams.length !== teamIds.length) {
      return { error: "invalid-assignment" as const }
    }

    await tx
      .insert(schema.socialAdmissionPolicies)
      .values({ enabled: input.enabled, organizationId: actor.organization.id })
      .onConflictDoUpdate({
        target: schema.socialAdmissionPolicies.organizationId,
        set: { enabled: input.enabled, updatedAt: new Date() },
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
    await tx.insert(schema.auditEvents).values({
      action: "social_admission.update",
      actorId: actor.userId,
      actorType: "user",
      after: [
        { field: "state", value: input.enabled ? "enabled" : "disabled" },
        { field: "role", value: `${roleIds.length} default Roles` },
      ],
      automaticCascade: false,
      category: "membership",
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(actor.headers, getAuth().options),
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: actor.organization.id,
      targetType: "organization",
      userAgent: actor.headers.get("user-agent"),
    })
    return {}
  })
}

export async function applyInvitation(invitationId: string) {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) {
    return { error: "unauthorized" as const }
  }

  let accepted
  try {
    accepted = await getAuth().api.acceptInvitation({
      headers: requestHeaders,
      body: { invitationId },
    })
  } catch (error) {
    if (error instanceof APIError) {
      if (error.body?.code === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION") {
        return { error: "email-mismatch" as const }
      }
      return { error: "not-found" as const }
    }
    throw error
  }

  const [organization] = await getDB()
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, accepted.invitation.organizationId))
    .limit(1)
  if (!organization) {
    return { error: "not-found" as const }
  }
  return { slug: organization.slug }
}
