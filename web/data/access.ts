import "server-only"

import { and, asc, eq, isNull, ne } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"

export type EffectiveAccessSource =
  | {
      id: string
      action: string
      resource: string
      role: string
      scope: string
      source: "Direct Role"
      systemRole: typeof schema.roleScopes.$inferSelect.systemRole
      workspaceId: string | null
    }
  | {
      id: string
      action: string
      resource: string
      role: string
      scope: string
      source: "Team Role"
      systemRole: typeof schema.roleScopes.$inferSelect.systemRole
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
      source: "Direct Share"
      workspaceId: string
    }
  | {
      id: string
      agent: string
      capability: string
      scope: string
      source: "Team Share"
      team: string
      workspaceId: string
    }

export type EffectiveAccessDetail = {
  organization: { id: string; name: string; slug: string }
  member: {
    id: string
    name: string
    email: string
    image: string | null
    status: "active" | "disabled" | "zero-access"
  }
  workspaces: { id: string; name: string; slug: string }[]
  sources: EffectiveAccessSource[]
}

export type TeamEffectiveAccessDetail = {
  organization: { id: string; name: string; slug: string }
  team: { id: string; name: string }
  members: { id: string; name: string; email: string; image: string | null }[]
  workspaces: { id: string; name: string; slug: string }[]
  sources: Array<{
    id: string
    action: string
    resource: string
    role: string
    scope: string
    source: "Team Role"
    systemRole: typeof schema.roleScopes.$inferSelect.systemRole
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
      image: schema.users.image,
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
  const [directRoles, teamRoles, ownedAgents, directShares, teamShares] = await Promise.all([
    db
      .select({
        action: schema.permissionGrants.action,
        grantWorkspaceId: schema.permissionGrants.workspaceId,
        resource: schema.permissionGrants.resource,
        roleId: schema.roleScopes.roleId,
        role: schema.roleScopes.displayName,
        roleWorkspaceId: schema.roleScopes.workspaceId,
        systemRole: schema.roleScopes.systemRole,
      })
      .from(schema.memberRoleAssignments)
      .innerJoin(
        schema.roleScopes,
        and(
          eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
          eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
        )
      )
      .leftJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.memberRoleAssignments.roleId),
          eq(schema.permissionGrants.organizationId, schema.memberRoleAssignments.organizationId),
          ne(schema.permissionGrants.resource, "api_key")
        )
      )
      .where(
        and(
          eq(schema.memberRoleAssignments.organizationId, org.id),
          eq(schema.memberRoleAssignments.memberId, member.id),
          isNull(schema.memberRoleAssignments.teamId)
        )
      )
      .orderBy(asc(schema.roleScopes.displayName), asc(schema.permissionGrants.resource))
      .limit(2000),
    db
      .select({
        teamId: schema.teams.id,
        team: schema.teams.name,
        action: schema.permissionGrants.action,
        grantWorkspaceId: schema.permissionGrants.workspaceId,
        resource: schema.permissionGrants.resource,
        roleId: schema.roleScopes.roleId,
        role: schema.roleScopes.displayName,
        roleWorkspaceId: schema.roleScopes.workspaceId,
        systemRole: schema.roleScopes.systemRole,
      })
      .from(schema.memberRoleAssignments)
      .innerJoin(
        schema.teams,
        and(
          eq(schema.teams.id, schema.memberRoleAssignments.teamId),
          eq(schema.teams.organizationId, schema.memberRoleAssignments.organizationId)
        )
      )
      .innerJoin(
        schema.roleScopes,
        and(
          eq(schema.roleScopes.roleId, schema.memberRoleAssignments.roleId),
          eq(schema.roleScopes.organizationId, schema.memberRoleAssignments.organizationId)
        )
      )
      .leftJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.memberRoleAssignments.roleId),
          eq(schema.permissionGrants.organizationId, schema.memberRoleAssignments.organizationId),
          ne(schema.permissionGrants.resource, "api_key")
        )
      )
      .where(
        and(
          eq(schema.memberRoleAssignments.organizationId, org.id),
          eq(schema.memberRoleAssignments.memberId, member.id)
        )
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
      .innerJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.agentShares.targetTeamId))
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
    ...[
      ...directRoles.map((role) => ({ ...role, source: "Direct Role" as const })),
      ...teamRoles.map((role) => ({ ...role, source: "Team Role" as const })),
    ].flatMap((row): EffectiveAccessSource[] => {
      if (row.systemRole === "superadmin" && row.roleWorkspaceId === null) {
        const prefix = row.source === "Team Role" ? `team:${row.teamId}` : "direct"
        return [
          { scope: "Organisation", workspaceId: null },
          ...workspaces.map(({ id, name }) => ({ scope: name, workspaceId: id })),
        ].map(({ scope, workspaceId }): EffectiveAccessSource => {
          const source = {
            action: "administer",
            id: `${prefix}:${row.roleId}:${workspaceId ?? "org"}:administration:administer`,
            resource: "administration",
            role: row.role,
            scope,
            systemRole: row.systemRole,
            workspaceId,
          }
          return row.source === "Team Role"
            ? { ...source, source: row.source, team: row.team }
            : { ...source, source: row.source }
        })
      }
      if (row.systemRole === "workspace_admin" && row.roleWorkspaceId) {
        const workspace = workspaceNames.get(row.roleWorkspaceId)
        if (!workspace) return []
        const prefix = row.source === "Team Role" ? `team:${row.teamId}` : "direct"
        const source = {
          action: "administer",
          id: `${prefix}:${row.roleId}:${row.roleWorkspaceId}:administration:administer`,
          resource: "administration",
          role: row.role,
          scope: workspace,
          systemRole: row.systemRole,
          workspaceId: row.roleWorkspaceId,
        }
        return row.source === "Team Role"
          ? [{ ...source, source: row.source, team: row.team }]
          : [{ ...source, source: row.source }]
      }
      if (!row.resource || !row.action) {
        return []
      }
      const scope = row.grantWorkspaceId ? workspaceNames.get(row.grantWorkspaceId) : "Organisation"
      if (!scope) return []
      const prefix = row.source === "Team Role" ? `team:${row.teamId}` : "direct"
      const source = {
        action: row.action,
        id: `${prefix}:${row.roleId}:${row.grantWorkspaceId ?? "org"}:${row.resource}:${row.action}`,
        resource: row.resource,
        role: row.role,
        scope,
        systemRole: null,
        workspaceId: row.grantWorkspaceId,
      }
      return row.source === "Team Role"
        ? [{ ...source, source: row.source, team: row.team }]
        : [{ ...source, source: row.source }]
    }),
  ]

  const superadmin = roleSources.some(
    (source) =>
      (source.source === "Direct Role" || source.source === "Team Role") &&
      source.systemRole === "superadmin"
  )
  const workspaceAdmins = new Set(
    roleSources.flatMap((source) =>
      (source.source === "Direct Role" || source.source === "Team Role") &&
      source.systemRole === "workspace_admin" &&
      source.workspaceId
        ? [source.workspaceId]
        : []
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
      image: member.image,
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
      .select({
        email: schema.users.email,
        id: schema.members.id,
        image: schema.users.image,
        name: schema.users.name,
      })
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
        action: schema.permissionGrants.action,
        grantWorkspaceId: schema.permissionGrants.workspaceId,
        resource: schema.permissionGrants.resource,
        roleId: schema.roleScopes.roleId,
        role: schema.roleScopes.displayName,
        roleWorkspaceId: schema.roleScopes.workspaceId,
        systemRole: schema.roleScopes.systemRole,
      })
      .from(schema.teamRoles)
      .innerJoin(
        schema.roleScopes,
        and(
          eq(schema.roleScopes.roleId, schema.teamRoles.roleId),
          eq(schema.roleScopes.organizationId, schema.teamRoles.organizationId)
        )
      )
      .leftJoin(
        schema.permissionGrants,
        and(
          eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
          eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId),
          ne(schema.permissionGrants.resource, "api_key")
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
    sources: grants.flatMap((grant): TeamEffectiveAccessDetail["sources"] => {
      if (grant.systemRole === "superadmin" && grant.roleWorkspaceId === null) {
        return [
          { scope: "Organisation", workspaceId: null },
          ...workspaces.map(({ id, name }) => ({ scope: name, workspaceId: id })),
        ].map(({ scope, workspaceId }) => ({
          action: "administer",
          id: `team:${team.id}:${grant.roleId}:${workspaceId ?? "org"}:administration:administer`,
          resource: "administration",
          role: grant.role,
          scope,
          source: "Team Role",
          systemRole: grant.systemRole,
          workspaceId,
        }))
      }
      if (grant.systemRole === "workspace_admin" && grant.roleWorkspaceId) {
        const scope = workspaceNames.get(grant.roleWorkspaceId)
        if (!scope) return []
        return [
          {
            action: "administer",
            id: `team:${team.id}:${grant.roleId}:${grant.roleWorkspaceId}:administration:administer`,
            resource: "administration",
            role: grant.role,
            scope,
            source: "Team Role",
            systemRole: grant.systemRole,
            workspaceId: grant.roleWorkspaceId,
          },
        ]
      }
      if (!grant.resource || !grant.action) return []
      const scope = grant.grantWorkspaceId
        ? workspaceNames.get(grant.grantWorkspaceId)
        : "Organisation"
      if (!scope) return []
      return [
        {
          action: grant.action,
          id: `team:${team.id}:${grant.roleId}:${grant.grantWorkspaceId ?? "org"}:${grant.resource}:${grant.action}`,
          resource: grant.resource,
          role: grant.role,
          scope,
          source: "Team Role",
          systemRole: null,
          workspaceId: grant.grantWorkspaceId,
        },
      ]
    }),
    workspaces,
  } satisfies TeamEffectiveAccessDetail
}
