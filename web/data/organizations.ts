import "server-only"

import type { Route } from "next"
import { cache } from "react"
import { and, asc, countDistinct, eq, isNotNull, isNull, or } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

export type OrganizationSummary = {
  id: string
  logo: string | null
  name: string
  slug: string
  superadmin: boolean
  hasAccess: boolean
}

type OrganizationDatabase = Pick<ReturnType<typeof getDB>, "select">

class FinalSuperadminError extends Error {}

export async function preserveActiveSuperadmin<T>(mutation: () => Promise<T>) {
  try {
    return await mutation()
  } catch (error) {
    if (error instanceof FinalSuperadminError) {
      return { error: "final-superadmin" as const }
    }
    throw error
  }
}

export async function assertActiveSuperadmin(db: OrganizationDatabase, organizationId: string) {
  const [row] = await db
    .select({ count: countDistinct(schema.memberRoleAssignments.memberId) })
    .from(schema.memberRoleAssignments)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.memberRoleAssignments.memberId),
        eq(schema.members.organizationId, schema.memberRoleAssignments.organizationId)
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
        eq(schema.memberRoleAssignments.organizationId, organizationId),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.systemRole, "superadmin")
      )
    )
  if (!row?.count) throw new FinalSuperadminError()
}

export async function isActiveSuperadmin(
  db: OrganizationDatabase,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const [role] = await db
    .select({ id: schema.memberRoleAssignments.roleId })
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
        eq(schema.members.organizationId, organizationId),
        eq(schema.members.userId, userId),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.systemRole, "superadmin"),
        eq(schema.roleScopes.immutable, true),
        isNull(schema.roleScopes.workspaceId)
      )
    )
    .limit(1)
  return role !== undefined
}

export async function lockOrganizationForSuperadmin(
  db: OrganizationDatabase,
  organizationId: string,
  userId: string
): Promise<boolean> {
  await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for("update")
  return isActiveSuperadmin(db, organizationId, userId)
}

export async function getOrganizationSession() {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) {
    return
  }

  const db = getDB()
  const organizationRows = db
    .select({
      id: schema.organizations.id,
      logo: schema.organizations.logo,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.members)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
    .where(and(eq(schema.members.userId, session.user.id), isNull(schema.members.disabledAt)))
    .orderBy(asc(schema.organizations.createdAt), asc(schema.organizations.id))
  const assignmentRows = db
    .selectDistinct({
      organizationId: schema.members.organizationId,
      systemRole: schema.roleScopes.systemRole,
    })
    .from(schema.memberRoleAssignments)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.memberRoleAssignments.memberId),
        eq(schema.members.organizationId, schema.memberRoleAssignments.organizationId)
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
        eq(schema.permissionGrants.organizationId, schema.memberRoleAssignments.organizationId)
      )
    )
    .where(
      and(
        eq(schema.members.userId, session.user.id),
        isNull(schema.members.disabledAt),
        or(isNotNull(schema.permissionGrants.resource), isNotNull(schema.roleScopes.systemRole))
      )
    )
  const [rows, assignments] = await Promise.all([organizationRows, assignmentRows])
  const superadminIds = new Set(
    assignments
      .filter(({ systemRole }) => systemRole === "superadmin")
      .map(({ organizationId }) => organizationId)
  )
  const accessibleIds = new Set(assignments.map(({ organizationId }) => organizationId))
  const organizations: OrganizationSummary[] = rows.map((organization) => ({
    ...organization,
    hasAccess: accessibleIds.has(organization.id),
    superadmin: superadminIds.has(organization.id),
  }))

  return {
    organizations,
    requestHeaders,
    session,
  }
}

export const resolveOrganizationSlug = cache(async (slug: string) => {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    return { kind: "unauthorized" as const }
  }

  const db = getDB()
  const [organization] = await db
    .select({
      id: schema.organizations.id,
      logo: schema.organizations.logo,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1)

  if (!organization) {
    return { kind: "not-found" as const }
  }

  const accessible = organizationSession.organizations.find(
    (candidate) => candidate.id === organization.id
  )
  if (!accessible) {
    const [membership] = await db
      .select({ disabledAt: schema.members.disabledAt })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, organization.id),
          eq(schema.members.userId, organizationSession.session.user.id)
        )
      )
      .limit(1)
    if (membership?.disabledAt) {
      return {
        kind: "disabled" as const,
        organizationSession,
      }
    }
    return {
      kind: "forbidden" as const,
      organizationSession,
    }
  }

  return {
    kind: "ready" as const,
    organization: accessible,
    organizationSession,
  }
})

export async function activateOrganization(organizationId: string) {
  const organizationSession = await getOrganizationSession()
  const organization = organizationSession?.organizations.find(
    (candidate) => candidate.id === organizationId
  )
  if (!organizationSession || !organization) {
    return
  }

  if (organizationSession.session.session.activeOrganizationId !== organization.id) {
    await getAuth().api.setActiveOrganization({
      body: { organizationId: organization.id },
      headers: organizationSession.requestHeaders,
    })
  }

  return organization
}

export async function rootOrganizationPath(): Promise<Route> {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    return "/signin"
  }

  const firstOrganization = organizationSession.organizations[0]
  if (!firstOrganization) {
    return "/settings/account"
  }

  const organization =
    organizationSession.organizations.find(
      (candidate) => candidate.id === organizationSession.session.session.activeOrganizationId
    ) ?? firstOrganization
  const [lastContext] = await getDB()
    .select({ route: schema.lastAccessibleContexts.route })
    .from(schema.lastAccessibleContexts)
    .where(
      and(
        eq(schema.lastAccessibleContexts.userId, organizationSession.session.user.id),
        eq(schema.lastAccessibleContexts.organizationId, organization.id)
      )
    )
    .limit(1)

  await activateOrganization(organization.id)
  return organizationDestination(organization, lastContext?.route)
}

export async function switchOrganization(organizationId: string): Promise<Route | undefined> {
  const organization = await activateOrganization(organizationId)
  const organizationSession = await getOrganizationSession()
  if (!organization || !organizationSession) {
    return
  }

  const [lastContext] = await getDB()
    .select({ route: schema.lastAccessibleContexts.route })
    .from(schema.lastAccessibleContexts)
    .where(
      and(
        eq(schema.lastAccessibleContexts.userId, organizationSession.session.user.id),
        eq(schema.lastAccessibleContexts.organizationId, organization.id)
      )
    )
    .limit(1)

  return organizationDestination(organization, lastContext?.route)
}

export async function rememberOrganizationRoute(
  organizationId: string,
  route: string,
  workspaceId: string | null
) {
  const organizationSession = await getOrganizationSession()
  const organization = organizationSession?.organizations.find(
    (candidate) => candidate.id === organizationId
  )
  if (!organizationSession || !organization) {
    return
  }

  const root = `/orgs/${organization.slug}`
  if (route !== root && !route.startsWith(`${root}/`)) {
    return
  }

  await getDB()
    .insert(schema.lastAccessibleContexts)
    .values({
      organizationId: organization.id,
      route,
      userId: organizationSession.session.user.id,
      workspaceId,
    })
    .onConflictDoUpdate({
      target: [schema.lastAccessibleContexts.userId, schema.lastAccessibleContexts.organizationId],
      set: {
        route,
        updatedAt: new Date(),
        workspaceId,
      },
    })
}

function organizationDestination(organization: OrganizationSummary, savedRoute?: string): Route {
  const root = `/orgs/${organization.slug}`
  if (!organization.hasAccess) {
    return root as Route
  }
  if (savedRoute === root || savedRoute?.startsWith(`${root}/`)) {
    return savedRoute as Route
  }

  if (organization.superadmin) {
    return `${root}/workspaces` as Route
  }

  return root as Route
}
