import "server-only"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"

export type EffectiveAccessRow = {
  memberId: string
  user: string
  email: string
  status: "active" | "disabled" | "zero-access"
  directRoles: number
  teamRoles: number
  teams: number
  ownedAgents: number
  sharedAgents: number
  explanation: string
}

export type EffectiveAccessSource =
  | {
      id: string
      action: "administer"
      resource: "administration"
      role: string
      scope: string
      source: "Superadmin" | "Workspace Admin"
      workspaceId: string | null
    }
  | {
      id: string
      action: string
      resource: string
      role: string
      scope: string
      source: "Direct Role"
      workspaceId: string | null
    }
  | {
      id: string
      action: string
      resource: string
      role: string
      scope: string
      source: "Team Role"
      team: string
      workspaceId: string | null
    }
  | {
      id: string
      agent: string
      scope: string
      source: "Ownership"
      workspaceId: string
    }
  | {
      id: string
      agent: string
      capability: string
      scope: string
      source: "Direct Share" | "Team Share"
      team?: string
      workspaceId: string
    }

export type EffectiveAccessDetail = {
  organization: { id: string; name: string; slug: string }
  member: {
    id: string
    name: string
    email: string
    status: "active" | "disabled" | "zero-access"
  }
  workspaces: { id: string; name: string; slug: string }[]
  sources: EffectiveAccessSource[]
}

export type TeamEffectiveAccessDetail = {
  organization: { id: string; name: string; slug: string }
  team: { id: string; name: string }
  members: { id: string; name: string; email: string }[]
  workspaces: { id: string; name: string; slug: string }[]
  sources: Array<{
    id: string
    action: string
    resource: string
    role: string
    scope: string
    source: "Team Role"
    workspaceId: string | null
  }>
}

async function getAccessOrganization(orgSlug: string) {
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready" || !result.organization.superadmin) {
    return
  }
  return result.organization
}

export async function listEffectiveAccess(orgSlug: string) {
  const org = await getAccessOrganization(orgSlug)
  if (!org) {
    return
  }

  const rows = await getDB()
    .select({
      memberId: schema.members.id,
      user: schema.users.name,
      email: schema.users.email,
      disabledAt: schema.members.disabledAt,
      directRoles: sql<number>`(
        SELECT count(*)::int FROM ${schema.memberRoles}
        WHERE ${schema.memberRoles.memberId} = ${schema.members.id}
          AND ${schema.memberRoles.organizationId} = ${org.id}
      )`,
      teamRoles: sql<number>`(
        SELECT count(*)::int
        FROM ${schema.teamMembers}
        JOIN ${schema.teamRoles} ON ${schema.teamRoles.teamId} = ${schema.teamMembers.teamId}
        WHERE ${schema.teamMembers.userId} = ${schema.members.userId}
          AND ${schema.teamRoles.organizationId} = ${org.id}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int
        FROM ${schema.teamMembers}
        JOIN ${schema.teams} ON ${schema.teams.id} = ${schema.teamMembers.teamId}
        WHERE ${schema.teamMembers.userId} = ${schema.members.userId}
          AND ${schema.teams.organizationId} = ${org.id}
      )`,
      ownedAgents: sql<number>`(
        SELECT count(*)::int FROM ${schema.agentOwners}
        WHERE ${schema.agentOwners.organizationId} = ${org.id}
          AND ${schema.agentOwners.ownerUserId} = ${schema.members.userId}
      )`,
      sharedAgents: sql<number>`(
        SELECT count(DISTINCT ${schema.agentShares.agentName})::int
        FROM ${schema.agentShares}
        LEFT JOIN ${schema.teamMembers}
          ON ${schema.teamMembers.teamId} = ${schema.agentShares.targetTeamId}
        WHERE ${schema.agentShares.organizationId} = ${org.id}
          AND (
            ${schema.agentShares.targetUserId} = ${schema.members.userId}
            OR ${schema.teamMembers.userId} = ${schema.members.userId}
          )
      )`,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.members.organizationId, org.id))
    .orderBy(asc(schema.users.name), asc(schema.users.email))
    .limit(200)

  return {
    organization: org,
    rows: rows.map((row): EffectiveAccessRow => {
      const assigned = row.directRoles + row.teamRoles
      const status = row.disabledAt ? "disabled" : assigned === 0 ? "zero-access" : "active"
      const sources = [
        row.directRoles ? `${row.directRoles} direct Role grants` : undefined,
        row.teamRoles ? `${row.teamRoles} Team Role grants` : undefined,
        row.ownedAgents ? `${row.ownedAgents} owned Agents` : undefined,
        row.sharedAgents ? `${row.sharedAgents} shared Agents` : undefined,
      ].filter(Boolean)

      return {
        ...row,
        explanation:
          sources.join(", ") ||
          (row.disabledAt
            ? "Membership is disabled; authentication may succeed but product access is denied."
            : "No direct or Team Roles currently grant product access."),
        status,
      }
    }),
  }
}

export async function getEffectiveAccessDetail(orgSlug: string, memberId: string) {
  const org = await getAccessOrganization(orgSlug)
  if (!org) {
    return
  }

  const db = getDB()
  const [member] = await db
    .select({
      id: schema.members.id,
      userId: schema.members.userId,
      name: schema.users.name,
      email: schema.users.email,
      disabledAt: schema.members.disabledAt,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(eq(schema.members.organizationId, org.id), eq(schema.members.id, memberId)))
    .limit(1)
  if (!member) {
    return null
  }

  const workspaces = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.organizationId, org.id), isNull(schema.workspaces.deletedAt)))
    .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.slug))
    .limit(500)

  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const [builtInRoles, directRoles, teamRoles, ownedAgents, directShares, teamShares] =
    await Promise.all([
      db
        .select({
          roleId: schema.roleScopes.roleId,
          role: schema.roleScopes.displayName,
          systemRole: schema.roleScopes.systemRole,
          workspaceId: schema.roleScopes.workspaceId,
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
            eq(schema.memberRoles.organizationId, org.id),
            eq(schema.memberRoles.memberId, member.id),
            eq(schema.roleScopes.immutable, true),
            inArray(schema.roleScopes.systemRole, ["superadmin", "workspace_admin"])
          )
        )
        .orderBy(asc(schema.roleScopes.workspaceId), asc(schema.roleScopes.displayName))
        .limit(2000),
      db
        .select({
          roleId: schema.roleScopes.roleId,
          role: schema.roleScopes.displayName,
          workspaceId: schema.permissionGrants.workspaceId,
          resource: schema.permissionGrants.resource,
          action: schema.permissionGrants.action,
        })
        .from(schema.memberRoles)
        .innerJoin(
          schema.roleScopes,
          and(
            eq(schema.roleScopes.roleId, schema.memberRoles.roleId),
            eq(schema.roleScopes.organizationId, schema.memberRoles.organizationId)
          )
        )
        .innerJoin(
          schema.permissionGrants,
          and(
            eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
            eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId)
          )
        )
        .where(
          and(
            eq(schema.memberRoles.organizationId, org.id),
            eq(schema.memberRoles.memberId, member.id)
          )
        )
        .orderBy(asc(schema.roleScopes.displayName), asc(schema.permissionGrants.resource))
        .limit(2000),
      db
        .select({
          teamId: schema.teams.id,
          team: schema.teams.name,
          roleId: schema.roleScopes.roleId,
          role: schema.roleScopes.displayName,
          workspaceId: schema.permissionGrants.workspaceId,
          resource: schema.permissionGrants.resource,
          action: schema.permissionGrants.action,
        })
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
        .innerJoin(
          schema.permissionGrants,
          and(
            eq(schema.permissionGrants.roleId, schema.roleScopes.roleId),
            eq(schema.permissionGrants.organizationId, schema.roleScopes.organizationId)
          )
        )
        .where(
          and(eq(schema.teams.organizationId, org.id), eq(schema.teamMembers.userId, member.userId))
        )
        .orderBy(asc(schema.teams.name), asc(schema.roleScopes.displayName))
        .limit(2000),
      db
        .select({
          workspaceId: schema.agentOwners.workspaceId,
          agent: schema.agentOwners.agentName,
        })
        .from(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, org.id),
            eq(schema.agentOwners.ownerUserId, member.userId)
          )
        )
        .orderBy(asc(schema.agentOwners.workspaceId), asc(schema.agentOwners.agentName))
        .limit(2000),
      db
        .select({
          id: schema.agentShares.id,
          workspaceId: schema.agentShares.workspaceId,
          agent: schema.agentShares.agentName,
          capability: schema.agentShareGrants.capability,
        })
        .from(schema.agentShares)
        .innerJoin(
          schema.agentShareGrants,
          eq(schema.agentShareGrants.shareId, schema.agentShares.id)
        )
        .where(
          and(
            eq(schema.agentShares.organizationId, org.id),
            eq(schema.agentShares.targetUserId, member.userId)
          )
        )
        .orderBy(asc(schema.agentShares.agentName), asc(schema.agentShareGrants.capability))
        .limit(2000),
      db
        .select({
          id: schema.agentShares.id,
          workspaceId: schema.agentShares.workspaceId,
          agent: schema.agentShares.agentName,
          capability: schema.agentShareGrants.capability,
          team: schema.teams.name,
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
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(
          and(
            eq(schema.agentShares.organizationId, org.id),
            eq(schema.teamMembers.userId, member.userId),
            eq(schema.teams.organizationId, org.id)
          )
        )
        .orderBy(asc(schema.teams.name), asc(schema.agentShares.agentName))
        .limit(2000),
    ])

  const roleSources: EffectiveAccessSource[] = [
    ...builtInRoles.flatMap((row): EffectiveAccessSource[] => {
      if (row.systemRole === "superadmin" && row.workspaceId === null) {
        return [
          {
            action: "administer",
            id: `superadmin:${row.roleId}:org`,
            resource: "administration",
            role: row.role,
            scope: "Organisation",
            source: "Superadmin",
            workspaceId: null,
          },
          ...workspaces.map(
            (workspace): EffectiveAccessSource => ({
              action: "administer",
              id: `superadmin:${row.roleId}:${workspace.id}`,
              resource: "administration",
              role: row.role,
              scope: workspace.name,
              source: "Superadmin",
              workspaceId: workspace.id,
            })
          ),
        ]
      }
      if (row.systemRole !== "workspace_admin" || !row.workspaceId) {
        return []
      }
      const workspace = workspaces.find((candidate) => candidate.id === row.workspaceId)
      if (!workspace) {
        return []
      }
      return [
        {
          action: "administer",
          id: `workspace-admin:${row.roleId}:${workspace.id}`,
          resource: "administration",
          role: row.role,
          scope: workspace.name,
          source: "Workspace Admin",
          workspaceId: workspace.id,
        },
      ]
    }),
    ...directRoles.flatMap((row): EffectiveAccessSource[] => {
      const scope = row.workspaceId ? workspaceNames.get(row.workspaceId) : "Organisation"
      if (!scope) {
        return []
      }
      return [
        {
          action: row.action,
          id: `direct:${row.roleId}:${row.workspaceId ?? "org"}:${row.resource}:${row.action}`,
          resource: row.resource,
          role: row.role,
          scope,
          source: "Direct Role",
          workspaceId: row.workspaceId,
        },
      ]
    }),
    ...teamRoles.flatMap((row): EffectiveAccessSource[] => {
      const scope = row.workspaceId ? workspaceNames.get(row.workspaceId) : "Organisation"
      if (!scope) {
        return []
      }
      return [
        {
          action: row.action,
          id: `team:${row.teamId}:${row.roleId}:${row.workspaceId ?? "org"}:${row.resource}:${row.action}`,
          resource: row.resource,
          role: row.role,
          scope,
          source: "Team Role",
          team: row.team,
          workspaceId: row.workspaceId,
        },
      ]
    }),
  ]

  const superadmin = roleSources.some((source) => source.source === "Superadmin")
  const workspaceAdmins = new Set(
    roleSources.flatMap((source) =>
      source.source === "Workspace Admin" && source.workspaceId ? [source.workspaceId] : []
    )
  )
  const accessibleWorkspaces = new Set(
    workspaces.flatMap((workspace) =>
      superadmin ||
      workspaceAdmins.has(workspace.id) ||
      roleSources.some(
        (source) =>
          (source.source === "Direct Role" || source.source === "Team Role") &&
          source.workspaceId === workspace.id
      )
        ? [workspace.id]
        : []
    )
  )
  const agentPermissions = new Set(
    roleSources.flatMap((source) =>
      (source.source === "Direct Role" || source.source === "Team Role") &&
      source.workspaceId &&
      source.resource === "agent"
        ? [`${source.workspaceId}:${source.action}`]
        : []
    )
  )

  const agentSources: EffectiveAccessSource[] = [
    ...ownedAgents.flatMap((row): EffectiveAccessSource[] => {
      const scope = workspaceNames.get(row.workspaceId)
      if (!scope || !accessibleWorkspaces.has(row.workspaceId)) {
        return []
      }
      return [
        {
          agent: row.agent,
          id: `owner:${row.workspaceId}:${row.agent}`,
          scope,
          source: "Ownership",
          workspaceId: row.workspaceId,
        },
      ]
    }),
    ...directShares.flatMap((row): EffectiveAccessSource[] => {
      const scope = workspaceNames.get(row.workspaceId)
      if (
        !scope ||
        !accessibleWorkspaces.has(row.workspaceId) ||
        (!superadmin &&
          !workspaceAdmins.has(row.workspaceId) &&
          !agentPermissions.has(`${row.workspaceId}:${row.capability}`))
      ) {
        return []
      }
      return [
        {
          agent: row.agent,
          capability: row.capability,
          id: `share:user:${row.id}:${row.capability}`,
          scope,
          source: "Direct Share",
          workspaceId: row.workspaceId,
        },
      ]
    }),
    ...teamShares.flatMap((row): EffectiveAccessSource[] => {
      const scope = workspaceNames.get(row.workspaceId)
      if (
        !scope ||
        !accessibleWorkspaces.has(row.workspaceId) ||
        (!superadmin &&
          !workspaceAdmins.has(row.workspaceId) &&
          !agentPermissions.has(`${row.workspaceId}:${row.capability}`))
      ) {
        return []
      }
      return [
        {
          agent: row.agent,
          capability: row.capability,
          id: `share:team:${row.id}:${row.capability}`,
          scope,
          source: "Team Share",
          team: row.team,
          workspaceId: row.workspaceId,
        },
      ]
    }),
  ]
  const status = member.disabledAt
    ? "disabled"
    : roleSources.length + agentSources.length === 0
      ? "zero-access"
      : "active"

  return {
    organization: org,
    member: {
      email: member.email,
      id: member.id,
      name: member.name,
      status,
    },
    sources: member.disabledAt ? [] : [...roleSources, ...agentSources],
    workspaces,
  } satisfies EffectiveAccessDetail
}

export async function getTeamEffectiveAccessDetail(orgSlug: string, teamId: string) {
  const org = await getAccessOrganization(orgSlug)
  if (!org) {
    return
  }

  const db = getDB()
  const [team] = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(and(eq(schema.teams.id, teamId), eq(schema.teams.organizationId, org.id)))
    .limit(1)
  if (!team) {
    return null
  }

  const [members, workspaces, grants] = await Promise.all([
    db
      .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
      .from(schema.teamMembers)
      .innerJoin(schema.members, eq(schema.members.userId, schema.teamMembers.userId))
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(
        and(
          eq(schema.teamMembers.teamId, team.id),
          eq(schema.members.organizationId, org.id),
          isNull(schema.members.disabledAt)
        )
      )
      .orderBy(asc(schema.users.name), asc(schema.users.email))
      .limit(200),
    db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
      })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.organizationId, org.id), isNull(schema.workspaces.deletedAt)))
      .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.slug))
      .limit(500),
    db
      .select({
        roleId: schema.roleScopes.roleId,
        role: schema.roleScopes.displayName,
        workspaceId: schema.permissionGrants.workspaceId,
        resource: schema.permissionGrants.resource,
        action: schema.permissionGrants.action,
      })
      .from(schema.teamRoles)
      .innerJoin(
        schema.roleScopes,
        and(
          eq(schema.roleScopes.roleId, schema.teamRoles.roleId),
          eq(schema.roleScopes.organizationId, schema.teamRoles.organizationId)
        )
      )
      .innerJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
          eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId)
        )
      )
      .where(and(eq(schema.teamRoles.teamId, team.id), eq(schema.teamRoles.organizationId, org.id)))
      .orderBy(asc(schema.roleScopes.displayName), asc(schema.permissionGrants.resource))
      .limit(2000),
  ])

  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  return {
    organization: org,
    team,
    members,
    sources: grants.flatMap((grant) => {
      if (grant.workspaceId && !workspaceNames.has(grant.workspaceId)) {
        return []
      }
      const scope = grant.workspaceId ? workspaceNames.get(grant.workspaceId) : "Organisation"
      if (!scope) {
        return []
      }
      return [
        {
          action: grant.action,
          id: `team:${team.id}:${grant.roleId}:${grant.workspaceId ?? "org"}:${grant.resource}:${grant.action}`,
          resource: grant.resource,
          role: grant.role,
          scope,
          source: "Team Role" as const,
          workspaceId: grant.workspaceId,
        },
      ]
    }),
    workspaces,
  } satisfies TeamEffectiveAccessDetail
}
