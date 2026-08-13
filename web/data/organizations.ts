import "server-only"

import { randomUUID } from "node:crypto"
import type { Route } from "next"
import { cache } from "react"
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

export type OrganizationSummary = {
  id: string
  name: string
  slug: string
  superadmin: boolean
  hasAccess: boolean
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
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.members)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
    .where(and(eq(schema.members.userId, session.user.id), isNull(schema.members.disabledAt)))
    .orderBy(asc(schema.organizations.createdAt), asc(schema.organizations.id))
  const systemRoleRows = db
    .selectDistinct({
      organizationId: schema.members.organizationId,
      systemRole: schema.roleScopes.systemRole,
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
    .where(
      and(
        eq(schema.members.userId, session.user.id),
        isNull(schema.members.disabledAt),
        isNotNull(schema.roleScopes.systemRole)
      )
    )
  const directGrantRows = db
    .selectDistinct({ organizationId: schema.members.organizationId })
    .from(schema.members)
    .innerJoin(
      schema.memberRoles,
      and(
        eq(schema.memberRoles.memberId, schema.members.id),
        eq(schema.memberRoles.organizationId, schema.members.organizationId)
      )
    )
    .innerJoin(
      schema.permissionGrants,
      and(
        eq(schema.permissionGrants.roleId, schema.memberRoles.roleId),
        eq(schema.permissionGrants.organizationId, schema.memberRoles.organizationId)
      )
    )
    .where(and(eq(schema.members.userId, session.user.id), isNull(schema.members.disabledAt)))
  const teamGrantRows = db
    .selectDistinct({ organizationId: schema.members.organizationId })
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
      schema.permissionGrants,
      and(
        eq(schema.permissionGrants.roleId, schema.teamRoles.roleId),
        eq(schema.permissionGrants.organizationId, schema.teamRoles.organizationId)
      )
    )
    .where(and(eq(schema.members.userId, session.user.id), isNull(schema.members.disabledAt)))
  const [rows, systemRoles, directGrants, teamGrants] = await Promise.all([
    organizationRows,
    systemRoleRows,
    directGrantRows,
    teamGrantRows,
  ])
  const superadminIds = new Set(
    systemRoles
      .filter(({ systemRole }) => systemRole === "superadmin")
      .map(({ organizationId }) => organizationId)
  )
  const accessibleIds = new Set([
    ...systemRoles.map(({ organizationId }) => organizationId),
    ...directGrants.map(({ organizationId }) => organizationId),
    ...teamGrants.map(({ organizationId }) => organizationId),
  ])
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
  let [organization] = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1)

  if (!organization) {
    const [historical] = await db
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
      })
      .from(schema.organizationSlugHistory)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.organizationSlugHistory.organizationId)
      )
      .where(eq(schema.organizationSlugHistory.slug, slug))
      .limit(1)

    organization = historical
  }

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
    retired: accessible.slug !== slug,
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

export type RenameOrganizationResult =
  | { slug: string }
  | { error: "forbidden" | "not-found" | "slug-unavailable" }

export async function renameOrganization(
  organizationId: string,
  input: { name: string; slug: string }
): Promise<RenameOrganizationResult> {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) {
    return { error: "forbidden" }
  }

  return getDB().transaction(async (tx) => {
    const [organization] = await tx
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .for("update")
      .limit(1)
    if (!organization) {
      return { error: "not-found" as const }
    }

    const eventTrail = {
      id: `event-trail-${randomUUID()}`,
      organizationId: organization.id,
      actorType: "user",
      actorId: organizationSession.session.user.id,
      targetType: "organization",
      targetId: organization.id,
      category: "organization",
      action: "organization.rename",
      before: [
        { field: "name", value: organization.name },
        { field: "slug", value: organization.slug },
      ],
      after: [
        { field: "name", value: input.name },
        { field: "slug", value: input.slug },
      ],
    } satisfies Omit<typeof schema.eventTrailEvents.$inferInsert, "result">

    const [member] = await tx
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.userId, organizationSession.session.user.id),
          eq(schema.members.organizationId, organization.id),
          isNull(schema.members.disabledAt)
        )
      )
      .limit(1)
    if (!member) {
      return { error: "forbidden" as const }
    }

    const [superadmin] = await tx
      .select({ roleId: schema.roleScopes.roleId })
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
          eq(schema.memberRoles.organizationId, organization.id),
          eq(schema.roleScopes.systemRole, "superadmin"),
          eq(schema.roleScopes.immutable, true)
        )
      )
      .limit(1)
    if (!superadmin) {
      await tx.insert(schema.eventTrailEvents).values({ ...eventTrail, result: "denied" })
      return { error: "forbidden" as const }
    }

    if (organization.slug !== input.slug) {
      const [canonicalSlug] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, input.slug))
        .limit(1)
      if (canonicalSlug) {
        await tx.insert(schema.eventTrailEvents).values({ ...eventTrail, result: "denied" })
        return { error: "slug-unavailable" as const }
      }

      await tx
        .insert(schema.organizationSlugHistory)
        .values({ organizationId: organization.id, slug: organization.slug })
        .onConflictDoNothing()
      const [reservedSlug] = await tx
        .insert(schema.organizationSlugHistory)
        .values({ organizationId: organization.id, slug: input.slug })
        .onConflictDoNothing()
        .returning({ slug: schema.organizationSlugHistory.slug })
      if (!reservedSlug) {
        await tx.insert(schema.eventTrailEvents).values({ ...eventTrail, result: "denied" })
        return { error: "slug-unavailable" as const }
      }
    }

    await tx
      .update(schema.organizations)
      .set({ name: input.name, slug: input.slug })
      .where(eq(schema.organizations.id, organization.id))
    await tx.insert(schema.eventTrailEvents).values({ ...eventTrail, result: "succeeded" })

    return { slug: input.slug }
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
