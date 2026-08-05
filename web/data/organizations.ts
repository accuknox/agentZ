import "server-only"

import { randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import type { Route } from "next"
import { cache } from "react"
import { and, asc, eq, isNull } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

export type OrganizationSummary = {
  id: string
  name: string
  slug: string
  superadmin: boolean
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
  const superadminRows = db
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
        eq(schema.roleScopes.systemRole, "superadmin")
      )
    )
  const [rows, superadminOrganizations] = await Promise.all([organizationRows, superadminRows])
  const superadminIds = new Set(superadminOrganizations.map((row) => row.organizationId))
  const organizations: OrganizationSummary[] = rows.map((organization) => ({
    ...organization,
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

    const audit = {
      id: `audit-${randomUUID()}`,
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
      automaticCascade: false,
      interface: "web",
      ipAddress: getIp(organizationSession.requestHeaders, getAuth().options),
      userAgent: organizationSession.requestHeaders.get("user-agent"),
    } satisfies Omit<typeof schema.auditEvents.$inferInsert, "result">

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
      await tx.insert(schema.auditEvents).values({ ...audit, result: "denied" })
      return { error: "forbidden" as const }
    }

    if (organization.slug !== input.slug) {
      const [canonicalSlug] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, input.slug))
        .limit(1)
      if (canonicalSlug) {
        await tx.insert(schema.auditEvents).values({ ...audit, result: "denied" })
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
        await tx.insert(schema.auditEvents).values({ ...audit, result: "denied" })
        return { error: "slug-unavailable" as const }
      }
    }

    await tx
      .update(schema.organizations)
      .set({ name: input.name, slug: input.slug })
      .where(eq(schema.organizations.id, organization.id))
    await tx.insert(schema.auditEvents).values({ ...audit, result: "succeeded" })

    return { slug: input.slug }
  })
}

function organizationDestination(organization: OrganizationSummary, savedRoute?: string): Route {
  if (organization.superadmin && savedRoute?.endsWith("/general")) {
    return `/orgs/${organization.slug}/general` as Route
  }

  if (organization.superadmin) {
    return `/orgs/${organization.slug}/workspaces` as Route
  }

  return `/orgs/${organization.slug}` as Route
}
