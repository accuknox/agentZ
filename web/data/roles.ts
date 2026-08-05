import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { getIp } from "better-auth/api"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { cacheLife, cacheTag } from "next/cache"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"
import { getAuth } from "@/lib/auth"

export type RoleResource = typeof schema.permissionGrants.$inferSelect.resource
export type RoleAction = typeof schema.permissionGrants.$inferSelect.action

export type RoleGrantInput = {
  workspaceId: string | null
  resource: RoleResource
  action: RoleAction
}

export type RoleGrant = RoleGrantInput & { locked: boolean }

export type RoleResourceDefinition = {
  resource: RoleResource
  label: string
  organisation: boolean
  workspace: boolean
  actions: RoleAction[]
}

export const roleResourceCatalog: RoleResourceDefinition[] = [
  {
    resource: "skill",
    label: "Immutable Skills",
    organisation: true,
    workspace: true,
    actions: ["read", "create", "modify", "delete"],
  },
  {
    resource: "sandbox",
    label: "Sandboxes",
    organisation: true,
    workspace: true,
    actions: ["read", "create", "modify", "delete"],
  },
  {
    resource: "mcp_connection",
    label: "MCP Connections",
    organisation: true,
    workspace: true,
    actions: ["read", "create", "delete"],
  },
  {
    resource: "inference_provider",
    label: "Inference Providers",
    organisation: true,
    workspace: true,
    actions: ["read", "create", "modify", "delete"],
  },
  {
    resource: "inference_pool",
    label: "Inference Pools",
    organisation: false,
    workspace: true,
    actions: ["read", "create", "modify", "delete"],
  },
  {
    resource: "observability",
    label: "Observability",
    organisation: false,
    workspace: true,
    actions: ["read"],
  },
  {
    resource: "api_key",
    label: "API Keys",
    organisation: false,
    workspace: true,
    actions: ["read", "create", "delete"],
  },
]

export const agentCapabilityCatalog: { action: RoleAction; label: string }[] = [
  { action: "author", label: "Author" },
  { action: "share_authored", label: "Share Authored" },
  { action: "share_non_authored", label: "Share Non-Authored" },
  { action: "use_shared", label: "Use Shared" },
  { action: "read_shared_secret", label: "Read Shared Secret" },
  { action: "write_shared_secret", label: "Write Shared Secret" },
  { action: "delete_shared_secret", label: "Delete Shared Secret" },
]

export type RoleWorkspace = { id: string; name: string }

export type OrganizationRoleSummary = {
  id: string
  name: string
  immutable: boolean
  systemRole: "superadmin" | "workspace_admin" | null
  users: number
  teams: number
  permissionCount: number
  dependencyState: "Built-in bypass" | "Expanded" | "Needs repair"
  updatedAt: string
}

export type OrganizationRoleDetail = {
  id: string
  name: string
  immutable: boolean
  systemRole: "superadmin" | "workspace_admin" | null
  grants: RoleGrant[]
  users: number
  teams: number
  updatedAt: string
}

export type RoleEditorData = {
  organization: { id: string; name: string; slug: string }
  workspaces: RoleWorkspace[]
  catalog: {
    resources: RoleResourceDefinition[]
    agentCapabilities: { action: RoleAction; label: string }[]
    organisationDependencies: RoleDependency[]
    workspaceDependencies: RoleDependency[]
  }
  role?: OrganizationRoleDetail
}

export type RoleDependency = {
  resource: RoleResource
  action: RoleAction
  requires: { resource: RoleResource; action: RoleAction }[]
}

export type RoleImpact = {
  fingerprint: string
  grants: RoleGrant[]
  items: { id: string; label: string; detail?: string }[]
  reduction: boolean
}

type RoleActor = {
  organization: { id: string; name: string; slug: string }
  requestHeaders: Headers
  userId: string
}

function grantKey(grant: RoleGrantInput) {
  return `${grant.workspaceId ?? "organisation"}\u001f${grant.resource}\u001f${grant.action}`
}

function available(resource: RoleResourceDefinition, workspaceId: string | null) {
  return workspaceId ? resource.workspace : resource.organisation
}

function requiredGrants(grant: RoleGrantInput): RoleGrantInput[] {
  const resource = roleResourceCatalog.find((candidate) => candidate.resource === grant.resource)
  const requirements: RoleGrantInput[] = []
  if (resource) {
    const index = resource.actions.indexOf(grant.action)
    if (index > 0) {
      for (const action of resource.actions.slice(0, index)) {
        requirements.push({ ...grant, action })
      }
    }
  }

  const add = (resourceName: RoleResource, action: RoleAction) => {
    const definition = roleResourceCatalog.find((candidate) => candidate.resource === resourceName)
    if (definition && available(definition, grant.workspaceId)) {
      requirements.push({
        workspaceId: grant.workspaceId,
        resource: resourceName,
        action,
      })
    }
  }

  if (grant.resource === "agent") {
    if (grant.action === "author") {
      add("sandbox", "read")
      add("skill", "read")
    }
    if (grant.action === "share_non_authored") {
      requirements.push({ ...grant, action: "use_shared" })
    }
    if (grant.action === "read_shared_secret") {
      requirements.push({ ...grant, action: "use_shared" })
    }
    if (grant.action === "write_shared_secret") {
      requirements.push({ ...grant, action: "read_shared_secret" })
    }
    if (grant.action === "delete_shared_secret") {
      requirements.push({ ...grant, action: "write_shared_secret" })
    }
  }

  if (grant.resource === "sandbox" && ["create", "modify"].includes(grant.action)) {
    add("mcp_connection", "read")
    add("skill", "read")
    add("inference_provider", "read")
    add("inference_pool", "read")
  }
  if (grant.resource === "inference_pool" && ["create", "modify"].includes(grant.action)) {
    add("inference_provider", "read")
  }

  return requirements
}

export function expandPermissionGrants(inputs: RoleGrantInput[]): RoleGrant[] {
  const direct = new Map(inputs.map((grant) => [grantKey(grant), grant]))
  const expanded = new Map(direct)
  const pending = [...direct.values()]

  for (const grant of pending) {
    for (const requirement of requiredGrants(grant)) {
      const key = grantKey(requirement)
      if (!expanded.has(key)) {
        expanded.set(key, requirement)
        pending.push(requirement)
      }
    }
  }

  return [...expanded.entries()]
    .map(([key, grant]) => ({ ...grant, locked: !direct.has(key) }))
    .sort((left, right) => grantKey(left).localeCompare(grantKey(right)))
}

function editorCatalog() {
  const dependencies = (workspaceId: string | null) => {
    const grants = [
      ...roleResourceCatalog
        .filter((resource) => available(resource, workspaceId))
        .flatMap((resource) =>
          resource.actions.map((action) => ({ workspaceId, resource: resource.resource, action }))
        ),
      ...(workspaceId
        ? agentCapabilityCatalog.map(({ action }) => ({
            workspaceId,
            resource: "agent" as const,
            action,
          }))
        : []),
    ]

    return grants.map((grant) => ({
      resource: grant.resource,
      action: grant.action,
      requires: requiredGrants(grant).map(({ resource, action }) => ({ resource, action })),
    }))
  }

  return {
    resources: roleResourceCatalog,
    agentCapabilities: agentCapabilityCatalog,
    organisationDependencies: dependencies(null),
    workspaceDependencies: dependencies("workspace"),
  }
}

async function getRoleActor(orgSlug: string): Promise<RoleActor | undefined> {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || !scope.organization.superadmin) {
    return
  }

  return {
    organization: scope.organization,
    requestHeaders: scope.organizationSession.requestHeaders,
    userId: scope.organizationSession.session.user.id,
  }
}

async function isCurrentSuperadmin(organizationId: string, userId: string) {
  const [row] = await getDB()
    .select({ memberId: schema.members.id })
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
        eq(schema.members.userId, userId),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.systemRole, "superadmin"),
        eq(schema.roleScopes.immutable, true)
      )
    )
    .limit(1)

  return Boolean(row)
}

async function validateGrantScopes(organizationId: string, grants: RoleGrantInput[]) {
  const workspaceIds = [...new Set(grants.flatMap((grant) => grant.workspaceId ?? []))]
  const workspaces = workspaceIds.length
    ? await getDB()
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.organizationId, organizationId),
            inArray(schema.workspaces.id, workspaceIds),
            isNull(schema.workspaces.deletedAt)
          )
        )
    : []
  if (workspaces.length !== workspaceIds.length) {
    return false
  }

  return grants.every((grant) => {
    if (grant.resource === "agent") {
      return (
        Boolean(grant.workspaceId) &&
        agentCapabilityCatalog.some(({ action }) => action === grant.action)
      )
    }
    const resource = roleResourceCatalog.find((candidate) => candidate.resource === grant.resource)
    return Boolean(
      resource && available(resource, grant.workspaceId) && resource.actions.includes(grant.action)
    )
  })
}

export async function listOrganizationRoles(orgSlug: string) {
  "use cache: private"
  cacheLife({ stale: 30 })

  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return
  }
  cacheTag(
    `organization:${actor.organization.id}:roles`,
    `organization:${actor.organization.id}:user:${actor.userId}:roles`
  )

  const rows = await getDB()
    .select({
      id: schema.roleScopes.roleId,
      immutable: schema.roleScopes.immutable,
      name: schema.roleScopes.displayName,
      systemRole: schema.roleScopes.systemRole,
      updatedAt: schema.roleScopes.updatedAt,
      users: sql<number>`(
        SELECT count(*)::int FROM member_roles
        WHERE member_roles.role_id = ${schema.roleScopes.roleId}
          AND member_roles.organization_id = ${schema.roleScopes.organizationId}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE team_roles.role_id = ${schema.roleScopes.roleId}
          AND team_roles.organization_id = ${schema.roleScopes.organizationId}
      )`,
    })
    .from(schema.roleScopes)
    .where(
      and(
        eq(schema.roleScopes.organizationId, actor.organization.id),
        isNull(schema.roleScopes.workspaceId)
      )
    )
    .orderBy(asc(schema.roleScopes.systemRole), asc(schema.roleScopes.displayName))
  const grants = rows.length
    ? await getDB()
        .select()
        .from(schema.permissionGrants)
        .where(
          and(
            eq(schema.permissionGrants.organizationId, actor.organization.id),
            inArray(
              schema.permissionGrants.roleId,
              rows.map((row) => row.id)
            )
          )
        )
    : []

  const roles: OrganizationRoleSummary[] = rows.map((row) => {
    const roleGrants = grants.filter((grant) => grant.roleId === row.id)
    const expected = expandPermissionGrants(
      roleGrants
        .filter((grant) => !grant.locked)
        .map(({ workspaceId, resource, action }) => ({
          workspaceId,
          resource,
          action,
        }))
    )
    const expanded =
      expected.length === roleGrants.length &&
      expected.every((grant) =>
        roleGrants.some(
          (stored) => grantKey(stored) === grantKey(grant) && stored.locked === grant.locked
        )
      )

    return {
      id: row.id,
      name: row.name,
      immutable: row.immutable,
      systemRole: row.systemRole,
      users: row.users,
      teams: row.teams,
      permissionCount: roleGrants.length,
      dependencyState: row.systemRole ? "Built-in bypass" : expanded ? "Expanded" : "Needs repair",
      updatedAt: row.updatedAt.toISOString(),
    }
  })

  return { organization: actor.organization, roles }
}

export async function getRoleEditorData(
  orgSlug: string,
  roleId?: string
): Promise<RoleEditorData | undefined> {
  "use cache: private"
  cacheLife({ stale: 30 })

  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return
  }
  cacheTag(
    `organization:${actor.organization.id}:roles`,
    `organization:${actor.organization.id}:user:${actor.userId}:roles`,
    ...(roleId ? [`organization:${actor.organization.id}:role:${roleId}`] : [])
  )

  const workspaces = await getDB()
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.organizationId, actor.organization.id),
        isNull(schema.workspaces.deletedAt)
      )
    )
    .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.id))
  if (!roleId) {
    return { organization: actor.organization, workspaces, catalog: editorCatalog() }
  }

  const [role] = await getDB()
    .select({
      id: schema.roleScopes.roleId,
      immutable: schema.roleScopes.immutable,
      name: schema.roleScopes.displayName,
      systemRole: schema.roleScopes.systemRole,
      updatedAt: schema.roleScopes.updatedAt,
      users: sql<number>`(
        SELECT count(*)::int FROM member_roles
        WHERE member_roles.role_id = ${schema.roleScopes.roleId}
          AND member_roles.organization_id = ${schema.roleScopes.organizationId}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE team_roles.role_id = ${schema.roleScopes.roleId}
          AND team_roles.organization_id = ${schema.roleScopes.organizationId}
      )`,
    })
    .from(schema.roleScopes)
    .where(
      and(
        eq(schema.roleScopes.organizationId, actor.organization.id),
        eq(schema.roleScopes.roleId, roleId),
        isNull(schema.roleScopes.workspaceId)
      )
    )
    .limit(1)
  if (!role) {
    return { organization: actor.organization, workspaces, catalog: editorCatalog() }
  }

  const grants = await getDB()
    .select({
      workspaceId: schema.permissionGrants.workspaceId,
      resource: schema.permissionGrants.resource,
      action: schema.permissionGrants.action,
      locked: schema.permissionGrants.locked,
    })
    .from(schema.permissionGrants)
    .where(
      and(
        eq(schema.permissionGrants.organizationId, actor.organization.id),
        eq(schema.permissionGrants.roleId, role.id)
      )
    )

  return {
    organization: actor.organization,
    workspaces,
    catalog: editorCatalog(),
    role: {
      ...role,
      grants,
      updatedAt: role.updatedAt.toISOString(),
    },
  }
}

export async function previewOrganizationRole(
  orgSlug: string,
  roleId: string,
  name: string,
  inputs: RoleGrantInput[],
  updatedAt: string
): Promise<RoleImpact | { error: "forbidden" | "invalid" | "not-found" | "stale" }> {
  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return { error: "forbidden" }
  }
  if (!(await validateGrantScopes(actor.organization.id, inputs))) {
    return { error: "invalid" }
  }

  const [role] = await getDB()
    .select({ id: schema.roleScopes.roleId, updatedAt: schema.roleScopes.updatedAt })
    .from(schema.roleScopes)
    .where(
      and(
        eq(schema.roleScopes.organizationId, actor.organization.id),
        eq(schema.roleScopes.roleId, roleId),
        isNull(schema.roleScopes.workspaceId)
      )
    )
    .limit(1)
  if (!role) {
    return { error: "not-found" }
  }
  if (role.updatedAt.toISOString() !== updatedAt) {
    return { error: "stale" }
  }

  const existing = await getDB()
    .select({
      workspaceId: schema.permissionGrants.workspaceId,
      resource: schema.permissionGrants.resource,
      action: schema.permissionGrants.action,
    })
    .from(schema.permissionGrants)
    .where(
      and(
        eq(schema.permissionGrants.organizationId, actor.organization.id),
        eq(schema.permissionGrants.roleId, role.id)
      )
    )
  const grants = expandPermissionGrants(inputs)
  const next = new Set(grants.map(grantKey))
  const removed = existing.filter((grant) => !next.has(grantKey(grant)))
  const [assignments] = await getDB()
    .select({
      users: sql<number>`(
        SELECT count(*)::int FROM member_roles
        WHERE role_id = ${role.id} AND organization_id = ${actor.organization.id}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE role_id = ${role.id} AND organization_id = ${actor.organization.id}
      )`,
    })
    .from(schema.roleScopes)
    .where(
      and(
        eq(schema.roleScopes.organizationId, actor.organization.id),
        eq(schema.roleScopes.roleId, role.id)
      )
    )
    .limit(1)
  const items = removed.map((grant) => ({
    id: grantKey(grant),
    label: `${grant.resource.replaceAll("_", " ")} · ${grant.action.replaceAll("_", " ")}`,
    detail: grant.workspaceId ? "Workspace grant removed" : "Organisation grant removed",
  }))
  if (removed.length && ((assignments?.users ?? 0) || (assignments?.teams ?? 0))) {
    items.unshift({
      id: "assignments",
      label: `${assignments?.users ?? 0} user and ${assignments?.teams ?? 0} team assignments may lose access`,
      detail: "Effective access remains the allow-only union of every other direct Role.",
    })
  }

  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ roleId, updatedAt, name, grants }))
      .digest("hex"),
    grants,
    items,
    reduction: removed.length > 0,
  }
}

export async function saveOrganizationRole(
  orgSlug: string,
  roleId: string | undefined,
  input: { name: string; grants: RoleGrantInput[]; updatedAt?: string; previewFingerprint?: string }
): Promise<
  | { roleId: string; organizationId: string }
  | {
      error:
        | "forbidden"
        | "immutable"
        | "invalid"
        | "name-taken"
        | "not-found"
        | "preview-required"
        | "stale"
    }
> {
  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return { error: "forbidden" }
  }
  if (!(await validateGrantScopes(actor.organization.id, input.grants))) {
    return { error: "invalid" }
  }

  const grants = expandPermissionGrants(input.grants)
  const auditRequest = {
    actorId: actor.userId,
    actorType: "user" as const,
    automaticCascade: false,
    category: "role",
    interface: "web" as const,
    ipAddress: getIp(actor.requestHeaders, getAuth().options),
    organizationId: actor.organization.id,
    userAgent: actor.requestHeaders.get("user-agent"),
  }

  return getDB().transaction(async (tx) => {
    const [authorized] = await tx
      .select({ memberId: schema.members.id })
      .from(schema.members)
      .innerJoin(schema.memberRoles, eq(schema.memberRoles.memberId, schema.members.id))
      .innerJoin(schema.roleScopes, eq(schema.roleScopes.roleId, schema.memberRoles.roleId))
      .where(
        and(
          eq(schema.members.organizationId, actor.organization.id),
          eq(schema.members.userId, actor.userId),
          isNull(schema.members.disabledAt),
          eq(schema.memberRoles.organizationId, actor.organization.id),
          eq(schema.roleScopes.organizationId, actor.organization.id),
          eq(schema.roleScopes.systemRole, "superadmin"),
          eq(schema.roleScopes.immutable, true)
        )
      )
      .limit(1)
    if (!authorized) {
      return { error: "forbidden" as const }
    }

    const workspaceIds = [...new Set(input.grants.flatMap((grant) => grant.workspaceId ?? []))]
    const workspaces = workspaceIds.length
      ? await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.organizationId, actor.organization.id),
              inArray(schema.workspaces.id, workspaceIds),
              isNull(schema.workspaces.deletedAt)
            )
          )
          .for("share")
      : []
    if (workspaces.length !== workspaceIds.length) {
      return { error: "invalid" as const }
    }

    const [taken] = await tx
      .select({ id: schema.roleScopes.roleId })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organization.id),
          isNull(schema.roleScopes.workspaceId),
          sql`lower(btrim(${schema.roleScopes.displayName})) = lower(btrim(${input.name}))`,
          roleId ? sql`${schema.roleScopes.roleId} <> ${roleId}` : undefined
        )
      )
      .limit(1)
    if (taken) {
      return { error: "name-taken" as const }
    }

    let id: string
    let before: { name: string; updatedAt: Date } | undefined
    let oldGrants: RoleGrantInput[] = []
    if (roleId) {
      id = roleId
      ;[before] = await tx
        .select({ name: schema.roleScopes.displayName, updatedAt: schema.roleScopes.updatedAt })
        .from(schema.roleScopes)
        .where(
          and(
            eq(schema.roleScopes.organizationId, actor.organization.id),
            eq(schema.roleScopes.roleId, id),
            isNull(schema.roleScopes.workspaceId),
            eq(schema.roleScopes.immutable, false)
          )
        )
        .for("update")
        .limit(1)
      if (!before) {
        const [immutable] = await tx
          .select({ id: schema.roleScopes.roleId })
          .from(schema.roleScopes)
          .where(
            and(
              eq(schema.roleScopes.organizationId, actor.organization.id),
              eq(schema.roleScopes.roleId, id),
              isNull(schema.roleScopes.workspaceId)
            )
          )
          .limit(1)
        return { error: immutable ? ("immutable" as const) : ("not-found" as const) }
      }
      if (before.updatedAt.toISOString() !== input.updatedAt) {
        return { error: "stale" as const }
      }
      oldGrants = await tx
        .select({
          workspaceId: schema.permissionGrants.workspaceId,
          resource: schema.permissionGrants.resource,
          action: schema.permissionGrants.action,
        })
        .from(schema.permissionGrants)
        .where(
          and(
            eq(schema.permissionGrants.organizationId, actor.organization.id),
            eq(schema.permissionGrants.roleId, id)
          )
        )
      const next = new Set(grants.map(grantKey))
      const reduction = oldGrants.some((grant) => !next.has(grantKey(grant)))
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({ roleId: id, updatedAt: input.updatedAt, name: input.name, grants })
        )
        .digest("hex")
      if (reduction && fingerprint !== input.previewFingerprint) {
        return { error: "preview-required" as const }
      }
    } else {
      id = `role-${randomUUID()}`
      await tx.insert(schema.organizationRoles).values({
        id,
        organizationId: actor.organization.id,
        permission: "{}",
        role: id,
      })
      await tx.insert(schema.roleScopes).values({
        displayName: input.name,
        organizationId: actor.organization.id,
        roleId: id,
      })
    }

    if (before) {
      await tx
        .update(schema.roleScopes)
        .set({ displayName: input.name, updatedAt: new Date() })
        .where(
          and(
            eq(schema.roleScopes.organizationId, actor.organization.id),
            eq(schema.roleScopes.roleId, id)
          )
        )
      await tx
        .delete(schema.permissionGrants)
        .where(
          and(
            eq(schema.permissionGrants.organizationId, actor.organization.id),
            eq(schema.permissionGrants.roleId, id)
          )
        )
    }
    if (grants.length) {
      await tx.insert(schema.permissionGrants).values(
        grants.map((grant) => ({
          ...grant,
          organizationId: actor.organization.id,
          roleId: id,
        }))
      )
    }
    await tx.insert(schema.auditEvents).values({
      ...auditRequest,
      id: `audit-${randomUUID()}`,
      action: before ? "role.update" : "role.create",
      after: [
        { field: "name", value: input.name },
        { field: "state", value: `${grants.length} Permission Grants` },
      ],
      before: before
        ? [
            { field: "name", value: before.name },
            { field: "state", value: `${oldGrants.length} Permission Grants` },
          ]
        : null,
      result: "succeeded",
      targetId: id,
      targetType: "role",
    })

    return { roleId: id, organizationId: actor.organization.id }
  })
}

export async function getOrganizationRoleUsers(orgSlug: string, roleId: string) {
  "use cache: private"
  cacheLife({ stale: 30 })

  const editor = await getRoleEditorData(orgSlug, roleId)
  if (!editor?.role) {
    return
  }

  const users = await getDB()
    .select({
      email: schema.users.email,
      memberId: schema.members.id,
      name: schema.users.name,
      assigned: sql<boolean>`EXISTS (
        SELECT 1 FROM member_roles
        WHERE member_roles.member_id = ${schema.members.id}
          AND member_roles.role_id = ${roleId}
          AND member_roles.organization_id = ${editor.organization.id}
      )`,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.members.organizationId, editor.organization.id),
        isNull(schema.members.disabledAt)
      )
    )
    .orderBy(asc(schema.users.name), asc(schema.users.email))

  return { ...editor, users }
}

export async function assignOrganizationRoleUsers(
  orgSlug: string,
  roleId: string,
  memberIds: string[]
): Promise<
  { organizationId: string } | { error: "final-superadmin" | "forbidden" | "invalid" | "not-found" }
> {
  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return { error: "forbidden" }
  }
  const selected = [...new Set(memberIds)]
  const auditRequest = {
    actorId: actor.userId,
    actorType: "user" as const,
    automaticCascade: false,
    category: "role",
    interface: "web" as const,
    ipAddress: getIp(actor.requestHeaders, getAuth().options),
    organizationId: actor.organization.id,
    userAgent: actor.requestHeaders.get("user-agent"),
  }

  return getDB().transaction(async (tx) => {
    const [role] = await tx
      .select({ systemRole: schema.roleScopes.systemRole })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organization.id),
          eq(schema.roleScopes.roleId, roleId),
          isNull(schema.roleScopes.workspaceId)
        )
      )
      .for("update")
      .limit(1)
    if (!role) {
      return { error: "not-found" as const }
    }
    const members = selected.length
      ? await tx
          .select({ id: schema.members.id })
          .from(schema.members)
          .where(
            and(
              eq(schema.members.organizationId, actor.organization.id),
              isNull(schema.members.disabledAt),
              inArray(schema.members.id, selected)
            )
          )
      : []
    if (members.length !== selected.length) {
      return { error: "invalid" as const }
    }

    const current = await tx
      .select({ memberId: schema.memberRoles.memberId })
      .from(schema.memberRoles)
      .where(
        and(
          eq(schema.memberRoles.organizationId, actor.organization.id),
          eq(schema.memberRoles.roleId, roleId)
        )
      )
    if (role.systemRole === "superadmin" && current.length > 0 && selected.length === 0) {
      return { error: "final-superadmin" as const }
    }

    const [authorized] = await tx
      .select({ memberId: schema.members.id })
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
          eq(schema.members.userId, actor.userId),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "superadmin"),
          eq(schema.roleScopes.immutable, true)
        )
      )
      .limit(1)
    if (!authorized) {
      return { error: "forbidden" as const }
    }

    await tx
      .delete(schema.memberRoles)
      .where(
        and(
          eq(schema.memberRoles.organizationId, actor.organization.id),
          eq(schema.memberRoles.roleId, roleId)
        )
      )
    if (selected.length) {
      await tx.insert(schema.memberRoles).values(
        selected.map((memberId) => ({
          memberId,
          organizationId: actor.organization.id,
          roleId,
        }))
      )
    }

    const affected = [...new Set([...current.map(({ memberId }) => memberId), ...selected])]
    for (const memberId of affected) {
      const transports = await tx
        .select({ role: schema.organizationRoles.role })
        .from(schema.memberRoles)
        .innerJoin(
          schema.organizationRoles,
          eq(schema.organizationRoles.id, schema.memberRoles.roleId)
        )
        .where(
          and(
            eq(schema.memberRoles.organizationId, actor.organization.id),
            eq(schema.memberRoles.memberId, memberId)
          )
        )
      await tx
        .update(schema.members)
        .set({
          role:
            transports
              .map(({ role: transport }) => transport)
              .sort()
              .join(",") || "member",
        })
        .where(
          and(
            eq(schema.members.organizationId, actor.organization.id),
            eq(schema.members.id, memberId)
          )
        )
    }

    await tx.insert(schema.auditEvents).values({
      ...auditRequest,
      id: `audit-${randomUUID()}`,
      action: "role.assign",
      after: selected.map((memberId) => ({ field: "member_id" as const, value: memberId })),
      before: current.map(({ memberId }) => ({ field: "member_id" as const, value: memberId })),
      result: "succeeded",
      targetId: roleId,
      targetType: "role",
    })

    return { organizationId: actor.organization.id }
  })
}

export async function deleteOrganizationRole(
  orgSlug: string,
  roleId: string
): Promise<
  | { organizationId: string }
  | { error: "forbidden" | "immutable" | "not-found" | "referenced"; references?: string[] }
> {
  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return { error: "forbidden" }
  }

  return getDB().transaction(async (tx) => {
    const [role] = await tx
      .select({ immutable: schema.roleScopes.immutable, name: schema.roleScopes.displayName })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organization.id),
          eq(schema.roleScopes.roleId, roleId),
          isNull(schema.roleScopes.workspaceId)
        )
      )
      .for("update")
      .limit(1)
    if (!role) {
      return { error: "not-found" as const }
    }
    if (role.immutable) {
      return { error: "immutable" as const }
    }

    const [references] = await tx
      .select({
        users: sql<number>`(
          SELECT count(*)::int FROM member_roles
          WHERE role_id = ${roleId} AND organization_id = ${actor.organization.id}
        )`,
        teams: sql<number>`(
          SELECT count(*)::int FROM team_roles
          WHERE role_id = ${roleId} AND organization_id = ${actor.organization.id}
        )`,
        invitations: sql<number>`(
          SELECT count(*)::int FROM invitation_roles
          JOIN invitations ON invitations.id = invitation_roles.invitation_id
          WHERE invitation_roles.role_id = ${roleId}
            AND invitation_roles.organization_id = ${actor.organization.id}
            AND invitations.organization_id = ${actor.organization.id}
            AND invitations.status = 'pending'
        )`,
        socialDefaults: sql<number>`(
          SELECT count(*)::int FROM social_admission_default_roles
          WHERE role_id = ${roleId} AND organization_id = ${actor.organization.id}
        )`,
      })
      .from(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organization.id),
          eq(schema.roleScopes.roleId, roleId)
        )
      )
      .limit(1)
    const blockers = [
      ...(references?.users ? [`${references.users} Users`] : []),
      ...(references?.teams ? [`${references.teams} Teams`] : []),
      ...(references?.invitations ? [`${references.invitations} pending Invitations`] : []),
      ...(references?.socialDefaults
        ? [`${references.socialDefaults} Social Admission defaults`]
        : []),
    ]
    if (blockers.length) {
      return { error: "referenced" as const, references: blockers }
    }

    const [authorized] = await tx
      .select({ memberId: schema.members.id })
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
          eq(schema.members.userId, actor.userId),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "superadmin"),
          eq(schema.roleScopes.immutable, true)
        )
      )
      .limit(1)
    if (!authorized) {
      return { error: "forbidden" as const }
    }

    await tx
      .delete(schema.roleScopes)
      .where(
        and(
          eq(schema.roleScopes.organizationId, actor.organization.id),
          eq(schema.roleScopes.roleId, roleId)
        )
      )
    await tx
      .delete(schema.organizationRoles)
      .where(
        and(
          eq(schema.organizationRoles.organizationId, actor.organization.id),
          eq(schema.organizationRoles.id, roleId)
        )
      )
    await tx.insert(schema.auditEvents).values({
      id: `audit-${randomUUID()}`,
      organizationId: actor.organization.id,
      actorType: "user",
      actorId: actor.userId,
      targetType: "role",
      targetId: roleId,
      category: "role",
      action: "role.delete",
      result: "succeeded",
      before: [{ field: "name", value: role.name }],
      automaticCascade: false,
      interface: "web",
      ipAddress: getIp(actor.requestHeaders, getAuth().options),
      userAgent: actor.requestHeaders.get("user-agent"),
    })

    return { organizationId: actor.organization.id }
  })
}
