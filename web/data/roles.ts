import "server-only"

import { createHash, randomUUID } from "node:crypto"
import type { UrlObject } from "node:url"
import { getIp } from "better-auth/api"
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { cacheLife, cacheTag } from "next/cache"
import { getDB, schema } from "@/db"
import { resolveOrganizationSlug } from "@/data/organizations"
import {
  analyzeRoleReductionEffects,
  type AffectedAPIKey,
  type CascadingAgent,
  type WorkspaceAccessLoss,
} from "@/data/operations"
import { getAuth } from "@/lib/auth"

export type RoleResource = typeof schema.permissionGrants.$inferSelect.resource
export type RoleAction = typeof schema.permissionGrants.$inferSelect.action
type AuditResult = typeof schema.auditEvents.$inferInsert.result

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

export type WorkspaceRoleEditorData = RoleEditorData & {
  workspace: RoleWorkspace & { slug: string }
  superadmin: boolean
}

export type RoleDependency = {
  resource: RoleResource
  action: RoleAction
  requires: { resource: RoleResource; action: RoleAction }[]
}

export type RoleImpact = {
  fingerprint: string
  grants: RoleGrant[]
  items: {
    id: string
    label: string
    detail?: string
    group?: string
    href?: UrlObject
    severity?: "critical" | "warning" | "info"
  }[]
  reduction: boolean
}

type RoleActor = {
  organization: { id: string; name: string; slug: string }
  requestHeaders: Headers
  userId: string
}

type WorkspaceRoleActor = RoleActor & {
  superadmin: boolean
  workspace: RoleWorkspace & { slug: string }
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
  const implied = new Set<string>()
  const pending = [...direct.values()]

  for (const grant of pending) {
    for (const requirement of requiredGrants(grant)) {
      const key = grantKey(requirement)
      implied.add(key)
      if (!expanded.has(key)) {
        expanded.set(key, requirement)
        pending.push(requirement)
      }
    }
  }

  return [...expanded.entries()]
    .map(([key, grant]) => ({ ...grant, locked: implied.has(key) }))
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

function roleAudit(
  actor: RoleActor,
  action: string,
  targetId: string,
  result: AuditResult,
  workspaceId?: string
) {
  return {
    actorId: actor.userId,
    actorType: "user" as const,
    action,
    automaticCascade: false,
    category: "role",
    id: `audit-${randomUUID()}`,
    interface: "web" as const,
    ipAddress: getIp(actor.requestHeaders, getAuth().options),
    organizationId: actor.organization.id,
    result,
    targetId,
    targetType: "role" as const,
    userAgent: actor.requestHeaders.get("user-agent"),
    workspaceId,
  }
}

async function getDeniedRoleActor(orgSlug: string): Promise<RoleActor | undefined> {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
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
  const workspaceIds = [
    ...new Set(grants.flatMap(({ workspaceId }) => (workspaceId === null ? [] : [workspaceId]))),
  ]
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
  const scope = await resolveRoleManagement(orgSlug)
  if (!scope) return
  cacheTag(
    `organization:${scope.actor.organization.id}:roles`,
    `organization:${scope.actor.organization.id}:user:${scope.actor.userId}:roles`
  )
  return { organization: scope.actor.organization, roles: await listRoles(scope) }
}

export async function getRoleEditorData(
  orgSlug: string,
  roleId?: string
): Promise<RoleEditorData | undefined> {
  "use cache: private"
  cacheLife({ stale: 30 })
  const scope = await resolveRoleManagement(orgSlug)
  if (!scope) return
  cacheTag(
    `organization:${scope.actor.organization.id}:roles`,
    `organization:${scope.actor.organization.id}:user:${scope.actor.userId}:roles`,
    ...(roleId ? [`organization:${scope.actor.organization.id}:role:${roleId}`] : [])
  )
  return loadRoleEditor(scope, roleId)
}

export async function previewOrganizationRole(
  orgSlug: string,
  roleId: string,
  name: string,
  inputs: RoleGrantInput[],
  updatedAt: string
): Promise<RoleImpact | { error: "forbidden" | "invalid" | "not-found" | "stale" }> {
  const scope = await resolveRoleManagement(orgSlug)
  return scope ? previewRole(scope, roleId, name, inputs, updatedAt) : { error: "forbidden" }
}

export async function saveOrganizationRole(
  orgSlug: string,
  roleId: string | undefined,
  input: { name: string; grants: RoleGrantInput[]; updatedAt?: string; previewFingerprint?: string }
) {
  const scope = await resolveRoleManagement(orgSlug)
  if (scope) return saveRole(scope, roleId, input)
  const denied = await getDeniedRoleActor(orgSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(denied, roleId ? "role.update" : "role.create", roleId ?? "new", "denied"))
  }
  return { error: "forbidden" as const }
}

export async function getOrganizationRoleUsers(orgSlug: string, roleId: string) {
  "use cache: private"
  cacheLife({ stale: 30 })
  const scope = await resolveRoleManagement(orgSlug)
  return scope ? loadRoleUsers(scope, roleId) : undefined
}

export async function assignOrganizationRoleUsers(
  orgSlug: string,
  roleId: string,
  memberIds: string[]
) {
  const scope = await resolveRoleManagement(orgSlug)
  if (scope) return assignRoleUsers(scope, roleId, memberIds)
  const denied = await getDeniedRoleActor(orgSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(denied, "role.assign", roleId, "denied"))
  }
  return { error: "forbidden" as const }
}

export async function deleteOrganizationRole(orgSlug: string, roleId: string) {
  const scope = await resolveRoleManagement(orgSlug)
  if (scope) return removeRole(scope, roleId)
  const denied = await getDeniedRoleActor(orgSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(denied, "role.delete", roleId, "denied"))
  }
  return { error: "forbidden" as const }
}

async function getWorkspaceRoleActor(
  orgSlug: string,
  workspaceSlug: string
): Promise<WorkspaceRoleActor | undefined> {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  let [workspace] = await getDB()
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.organizationId, scope.organization.id),
        eq(schema.workspaces.slug, workspaceSlug),
        isNull(schema.workspaces.deletedAt)
      )
    )
    .limit(1)
  if (!workspace) {
    ;[workspace] = await getDB()
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
      })
      .from(schema.workspaceSlugHistory)
      .innerJoin(
        schema.workspaces,
        and(
          eq(schema.workspaces.id, schema.workspaceSlugHistory.workspaceId),
          eq(schema.workspaces.organizationId, schema.workspaceSlugHistory.organizationId)
        )
      )
      .where(
        and(
          eq(schema.workspaceSlugHistory.organizationId, scope.organization.id),
          eq(schema.workspaceSlugHistory.slug, workspaceSlug),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .limit(1)
  }
  if (!workspace) {
    return
  }

  const [authority] = await getDB()
    .select({ systemRole: schema.roleScopes.systemRole })
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
        eq(schema.members.organizationId, scope.organization.id),
        eq(schema.members.userId, scope.organizationSession.session.user.id),
        isNull(schema.members.disabledAt),
        eq(schema.roleScopes.immutable, true),
        sql`(
          (${schema.roleScopes.systemRole} = 'superadmin' AND
            ${schema.roleScopes.workspaceId} IS NULL) OR
          (${schema.roleScopes.systemRole} = 'workspace_admin' AND
            ${schema.roleScopes.workspaceId} = ${workspace.id})
        )`
      )
    )
    .orderBy(sql`${schema.roleScopes.systemRole} = 'superadmin' DESC`)
    .limit(1)
  if (!authority) {
    return
  }

  return {
    organization: scope.organization,
    requestHeaders: scope.organizationSession.requestHeaders,
    superadmin: authority.systemRole === "superadmin",
    userId: scope.organizationSession.session.user.id,
    workspace,
  }
}

async function getDeniedWorkspaceRoleActor(
  orgSlug: string,
  workspaceSlug: string
): Promise<WorkspaceRoleActor | undefined> {
  const actor = await getDeniedRoleActor(orgSlug)
  if (!actor) {
    return
  }
  const [workspace] = await getDB()
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.organizationId, actor.organization.id),
        isNull(schema.workspaces.deletedAt),
        sql`(
          ${schema.workspaces.slug} = ${workspaceSlug} OR EXISTS (
            SELECT 1 FROM workspace_slug_history
            WHERE workspace_slug_history.organization_id = ${actor.organization.id}
              AND workspace_slug_history.workspace_id = ${schema.workspaces.id}
              AND workspace_slug_history.slug = ${workspaceSlug}
          )
        )`
      )
    )
    .limit(1)
  if (!workspace) {
    return
  }

  return { ...actor, superadmin: false, workspace }
}

function validWorkspaceGrants(workspaceId: string, grants: RoleGrantInput[]) {
  return grants.every((grant) => {
    if (grant.workspaceId !== workspaceId) {
      return false
    }
    if (grant.resource === "agent") {
      return agentCapabilityCatalog.some(({ action }) => action === grant.action)
    }
    const resource = roleResourceCatalog.find((candidate) => candidate.resource === grant.resource)
    return Boolean(resource?.workspace && resource.actions.includes(grant.action))
  })
}

type RoleManagement = {
  actor: RoleActor
  superadmin: boolean
  workspace: (RoleWorkspace & { slug: string }) | null
}

async function resolveRoleManagement(orgSlug: string, workspaceSlug?: string) {
  if (workspaceSlug) {
    const actor = await getWorkspaceRoleActor(orgSlug, workspaceSlug)
    return actor ? { actor, superadmin: actor.superadmin, workspace: actor.workspace } : undefined
  }

  const actor = await getRoleActor(orgSlug)
  if (!actor || !(await isCurrentSuperadmin(actor.organization.id, actor.userId))) {
    return
  }
  return { actor, superadmin: true, workspace: null }
}

function roleScope(scope: RoleManagement) {
  return and(
    eq(schema.roleScopes.organizationId, scope.actor.organization.id),
    scope.workspace
      ? eq(schema.roleScopes.workspaceId, scope.workspace.id)
      : isNull(schema.roleScopes.workspaceId)
  )
}

function grantScope(scope: RoleManagement) {
  return and(
    eq(schema.permissionGrants.organizationId, scope.actor.organization.id),
    scope.workspace ? eq(schema.permissionGrants.workspaceId, scope.workspace.id) : undefined
  )
}

async function listRoles(scope: RoleManagement) {
  const rows = await getDB()
    .select({
      id: schema.roleScopes.roleId,
      immutable: schema.roleScopes.immutable,
      name: schema.roleScopes.displayName,
      systemRole: schema.roleScopes.systemRole,
      updatedAt: schema.roleScopes.updatedAt,
      users: sql<number>`(
        SELECT count(*)::int FROM member_roles
        WHERE member_roles.role_id =
          ${sql.identifier("role_scopes")}.${schema.roleScopes.roleId}
          AND member_roles.organization_id =
            ${sql.identifier("role_scopes")}.${schema.roleScopes.organizationId}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE team_roles.role_id =
          ${sql.identifier("role_scopes")}.${schema.roleScopes.roleId}
          AND team_roles.organization_id =
            ${sql.identifier("role_scopes")}.${schema.roleScopes.organizationId}
      )`,
    })
    .from(schema.roleScopes)
    .where(roleScope(scope))
    .orderBy(asc(schema.roleScopes.systemRole), asc(schema.roleScopes.displayName))
  const stored = rows.length
    ? await getDB()
        .select()
        .from(schema.permissionGrants)
        .where(
          and(
            grantScope(scope),
            ne(schema.permissionGrants.resource, "api_key"),
            inArray(
              schema.permissionGrants.roleId,
              rows.map(({ id }) => id)
            )
          )
        )
    : []

  return rows.map((row): OrganizationRoleSummary => {
    const roleGrants = stored.filter(({ roleId }) => roleId === row.id)
    const expected = expandPermissionGrants(
      roleGrants
        .filter(({ locked }) => !locked)
        .map(({ workspaceId, resource, action }) => ({ workspaceId, resource, action }))
    )
    const expanded =
      expected.length === roleGrants.length &&
      expected.every((grant) =>
        roleGrants.some(
          (candidate) =>
            grantKey(candidate) === grantKey(grant) && candidate.locked === grant.locked
        )
      )

    return {
      ...row,
      permissionCount: roleGrants.length,
      dependencyState: row.systemRole ? "Built-in bypass" : expanded ? "Expanded" : "Needs repair",
      updatedAt: row.updatedAt.toISOString(),
    }
  })
}

async function loadRoleEditor(scope: RoleManagement, roleId?: string): Promise<RoleEditorData> {
  const workspaces = scope.workspace
    ? [scope.workspace]
    : await getDB()
        .select({ id: schema.workspaces.id, name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.organizationId, scope.actor.organization.id),
            isNull(schema.workspaces.deletedAt)
          )
        )
        .orderBy(asc(schema.workspaces.name), asc(schema.workspaces.id))
  const base = {
    catalog: editorCatalog(),
    organization: scope.actor.organization,
    workspaces,
  }
  if (!roleId) {
    return base
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
        WHERE member_roles.role_id =
          ${sql.identifier("role_scopes")}.${schema.roleScopes.roleId}
          AND member_roles.organization_id =
            ${sql.identifier("role_scopes")}.${schema.roleScopes.organizationId}
      )`,
      teams: sql<number>`(
        SELECT count(*)::int FROM team_roles
        WHERE team_roles.role_id =
          ${sql.identifier("role_scopes")}.${schema.roleScopes.roleId}
          AND team_roles.organization_id =
            ${sql.identifier("role_scopes")}.${schema.roleScopes.organizationId}
      )`,
    })
    .from(schema.roleScopes)
    .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
    .limit(1)
  if (!role) {
    return base
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
        grantScope(scope),
        eq(schema.permissionGrants.roleId, role.id),
        ne(schema.permissionGrants.resource, "api_key")
      )
    )

  return { ...base, role: { ...role, grants, updatedAt: role.updatedAt.toISOString() } }
}

async function previewRole(
  scope: RoleManagement,
  roleId: string,
  name: string,
  inputs: RoleGrantInput[],
  updatedAt: string
): Promise<RoleImpact | { error: "invalid" | "not-found" | "stale" }> {
  const valid = scope.workspace
    ? validWorkspaceGrants(scope.workspace.id, inputs)
    : await validateGrantScopes(scope.actor.organization.id, inputs)
  if (!valid) {
    return { error: "invalid" }
  }

  const [role] = await getDB()
    .select({ updatedAt: schema.roleScopes.updatedAt })
    .from(schema.roleScopes)
    .where(
      and(
        roleScope(scope),
        eq(schema.roleScopes.roleId, roleId),
        scope.workspace ? eq(schema.roleScopes.immutable, false) : undefined
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
          grantScope(scope),
          eq(schema.permissionGrants.roleId, roleId),
          ne(schema.permissionGrants.resource, "api_key")
        )
      )
  const grants = expandPermissionGrants(inputs)
  const next = new Set(grants.map(grantKey))
  const removed = existing.filter((grant) => !next.has(grantKey(grant)))
  const items: RoleImpact["items"] = removed.map((grant) => ({
    id: grantKey(grant),
    label: `${grant.resource.replaceAll("_", " ")} · ${grant.action.replaceAll("_", " ")}`,
    detail: scope.workspace
      ? scope.workspace.name
      : grant.workspaceId
        ? "Workspace grant removed"
        : "Organisation grant removed",
  }))

  if (!scope.workspace && removed.length) {
    const [assignments] = await getDB()
      .select({
        users: sql<number>`(
          SELECT count(*)::int FROM member_roles
          WHERE role_id = ${roleId} AND organization_id = ${scope.actor.organization.id}
        )`,
        teams: sql<number>`(
          SELECT count(*)::int FROM team_roles
          WHERE role_id = ${roleId} AND organization_id = ${scope.actor.organization.id}
        )`,
      })
      .from(schema.roleScopes)
      .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
      .limit(1)
    if ((assignments?.users ?? 0) || (assignments?.teams ?? 0)) {
      items.unshift({
        id: "assignments",
        label: `${assignments?.users ?? 0} user and ${assignments?.teams ?? 0} team assignments may lose access`,
        detail: "Effective access remains the allow-only union of every other direct Role.",
      })
    }
  }

  const remainingWorkspaces = new Set(
    grants.flatMap(({ workspaceId }) => (workspaceId ? [workspaceId] : []))
  )
  const removedWorkspaceIds = [
    ...new Set(
      removed.flatMap(({ workspaceId }) =>
        workspaceId && !remainingWorkspaces.has(workspaceId) ? [workspaceId] : []
      )
    ),
  ]
  const effects = await analyzeRoleReductionEffects(
    getDB(),
    scope.actor.organization.id,
    roleId,
    removedWorkspaceIds
  )
  items.push(
    ...effects.losses.map((loss) => ({
      detail: `${loss.name} loses their final role-derived access path.`,
      group: "Access loss",
      href: {
        pathname: `/orgs/${scope.actor.organization.slug}/access/${loss.memberId}`,
        query: { scope: loss.workspaceId },
      },
      id: `workspace-loss:${loss.userId}:${loss.workspaceId}`,
      label: loss.workspace,
      severity: "critical" as const,
    })),
    ...effects.agents.map((agent) => ({
      detail: `${agent.workspace}; transfer ownership before saving to preserve this Agent.`,
      group: "Owned Agents",
      href: {
        pathname: `/orgs/${scope.actor.organization.slug}/workspaces/${agent.workspaceSlug}/agents/${encodeURIComponent(agent.agentName)}/ownership`,
      },
      id: `agent:${agent.workspaceId}:${agent.agentName}`,
      label: agent.agentName,
      severity: "critical" as const,
    })),
    ...effects.keys.map((key) => ({
      detail: `${key.workspace}; access to its creator or selected target is removed.`,
      group: "API keys",
      href: {
        pathname: "/settings/api-keys",
      },
      id: `key:${key.id}`,
      label: key.name,
      severity: "critical" as const,
    }))
  )

  return {
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          roleId,
          updatedAt,
          name,
          grants,
          cascade: {
            agents: effects.agents.map(({ agentName, workspaceId }) => ({
              agentName,
              workspaceId,
            })),
            keys: effects.keys.map(({ id }) => id),
            losses: effects.losses.map(({ userId, workspaceId }) => ({ userId, workspaceId })),
            memberIds: effects.memberIds,
          },
        })
      )
      .digest("hex"),
    grants,
    items,
    reduction: removed.length > 0,
  }
}

async function saveRole(
  scope: RoleManagement,
  roleId: string | undefined,
  input: { name: string; grants: RoleGrantInput[]; updatedAt?: string; previewFingerprint?: string }
) {
  const { actor, workspace } = scope
  const action = `${workspace ? "workspace_role" : "role"}.${roleId ? "update" : "create"}`
  const valid = workspace
    ? validWorkspaceGrants(workspace.id, input.grants)
    : await validateGrantScopes(actor.organization.id, input.grants)
  if (!valid) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(actor, action, roleId ?? "new", "failed", workspace?.id))
    return { error: "invalid" as const }
  }
  const grants = expandPermissionGrants(input.grants)

  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.organization.id))
      .for("update")

    const [authorized] = await tx
      .select({ systemRole: schema.roleScopes.systemRole })
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
          eq(schema.roleScopes.immutable, true),
          workspace
            ? sql`(
                (${schema.roleScopes.systemRole} = 'superadmin' AND
                  ${schema.roleScopes.workspaceId} IS NULL) OR
                (${schema.roleScopes.systemRole} = 'workspace_admin' AND
                  ${schema.roleScopes.workspaceId} = ${workspace.id})
              )`
            : and(
                eq(schema.roleScopes.systemRole, "superadmin"),
                isNull(schema.roleScopes.workspaceId)
              )
        )
      )
      .limit(1)
    if (!authorized) {
      await tx
        .insert(schema.auditEvents)
        .values(roleAudit(actor, action, roleId ?? "new", "denied", workspace?.id))
      return { error: "forbidden" as const }
    }

    if (workspace) {
      const [locked] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, workspace.id),
            eq(schema.workspaces.organizationId, actor.organization.id),
            isNull(schema.workspaces.deletedAt)
          )
        )
        .for("update")
      if (!locked) return { error: "invalid" as const }
    } else {
      const workspaceIds = [
        ...new Set(
          input.grants.flatMap(({ workspaceId }) => (workspaceId === null ? [] : [workspaceId]))
        ),
      ]
      const locked = workspaceIds.length
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
      if (locked.length !== workspaceIds.length) return { error: "invalid" as const }
    }

    const [taken] = await tx
      .select({ id: schema.roleScopes.roleId })
      .from(schema.roleScopes)
      .where(
        and(
          roleScope(scope),
          sql`lower(btrim(${schema.roleScopes.displayName})) = lower(btrim(${input.name}))`,
          roleId ? sql`${schema.roleScopes.roleId} <> ${roleId}` : undefined
        )
      )
      .limit(1)
    if (taken) return { error: "name-taken" as const }

    let id = roleId
    let before: { name: string; updatedAt: Date } | undefined
    let oldGrants: RoleGrantInput[] = []
    let reduction = false
    let cascade:
      | {
          agents: CascadingAgent[]
          keys: AffectedAPIKey[]
          losses: WorkspaceAccessLoss[]
          memberIds: string[]
        }
      | undefined
    if (id) {
      ;[before] = await tx
        .select({ name: schema.roleScopes.displayName, updatedAt: schema.roleScopes.updatedAt })
        .from(schema.roleScopes)
        .where(
          and(
            roleScope(scope),
            eq(schema.roleScopes.roleId, id),
            eq(schema.roleScopes.immutable, false)
          )
        )
        .for("update")
        .limit(1)
      if (!before) {
        const [immutable] = await tx
          .select({ id: schema.roleScopes.roleId })
          .from(schema.roleScopes)
          .where(and(roleScope(scope), eq(schema.roleScopes.roleId, id)))
          .limit(1)
        if (!immutable) return { error: "not-found" as const }
        await tx.insert(schema.auditEvents).values({
          actorId: actor.userId,
          actorType: "user",
          action,
          automaticCascade: false,
          category: "role",
          id: `audit-${randomUUID()}`,
          interface: "web",
          ipAddress: getIp(actor.requestHeaders, getAuth().options),
          organizationId: actor.organization.id,
          result: "denied",
          targetId: id,
          targetType: "role",
          userAgent: actor.requestHeaders.get("user-agent"),
          workspaceId: workspace?.id,
        })
        return { error: "immutable" as const }
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
        .where(and(grantScope(scope), eq(schema.permissionGrants.roleId, id)))
      const next = new Set(grants.map(grantKey))
      reduction = oldGrants.some((grant) => !next.has(grantKey(grant)))
      const remainingWorkspaces = new Set(
        grants.flatMap(({ workspaceId }) => (workspaceId ? [workspaceId] : []))
      )
      const removedWorkspaceIds = [
        ...new Set(
          oldGrants.flatMap(({ workspaceId }) =>
            workspaceId && !remainingWorkspaces.has(workspaceId) ? [workspaceId] : []
          )
        ),
      ]
      cascade = await analyzeRoleReductionEffects(
        tx,
        actor.organization.id,
        id,
        removedWorkspaceIds
      )
      if (cascade.memberIds.length) {
        await tx
          .select({ id: schema.members.id })
          .from(schema.members)
          .where(
            and(
              eq(schema.members.organizationId, actor.organization.id),
              inArray(schema.members.id, cascade.memberIds)
            )
          )
          .for("update")
      }
      if (cascade.agents.length) {
        await tx
          .select({ agentName: schema.agentOwners.agentName })
          .from(schema.agentOwners)
          .where(
            and(
              eq(schema.agentOwners.organizationId, actor.organization.id),
              or(
                ...cascade.agents.map((agent) =>
                  and(
                    eq(schema.agentOwners.workspaceId, agent.workspaceId),
                    eq(schema.agentOwners.agentName, agent.agentName)
                  )
                )
              )
            )
          )
          .for("update")
      }
      cascade = await analyzeRoleReductionEffects(
        tx,
        actor.organization.id,
        id,
        removedWorkspaceIds
      )
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            roleId: id,
            updatedAt: input.updatedAt,
            name: input.name,
            grants,
            cascade: {
              agents: cascade.agents.map(({ agentName, workspaceId }) => ({
                agentName,
                workspaceId,
              })),
              keys: cascade.keys.map(({ id: keyId }) => keyId),
              losses: cascade.losses.map(({ userId, workspaceId }) => ({ userId, workspaceId })),
              memberIds: cascade.memberIds,
            },
          })
        )
        .digest("hex")
      if (reduction && fingerprint !== input.previewFingerprint) {
        return { error: "preview-required" as const }
      }
      await tx
        .update(schema.roleScopes)
        .set({ displayName: input.name, updatedAt: new Date() })
        .where(and(roleScope(scope), eq(schema.roleScopes.roleId, id)))
      await tx
        .delete(schema.permissionGrants)
        .where(
          and(
            eq(schema.permissionGrants.organizationId, actor.organization.id),
            eq(schema.permissionGrants.roleId, id)
          )
        )
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
        workspaceId: workspace?.id ?? null,
      })
    }

    if (grants.length) {
      await tx
        .insert(schema.permissionGrants)
        .values(
          grants.map((grant) => ({ ...grant, organizationId: actor.organization.id, roleId: id }))
        )
    }
    const now = new Date()
    if (cascade?.keys.length) {
      const keyIds = cascade.keys.map(({ id: keyId }) => keyId)
      await tx
        .update(schema.apiKeyScopes)
        .set({ revokedAt: now, revokedReason: `Role ${input.name} reduction removed access.` })
        .where(
          and(
            eq(schema.apiKeyScopes.organizationId, actor.organization.id),
            inArray(schema.apiKeyScopes.apiKeyId, keyIds),
            isNull(schema.apiKeyScopes.revokedAt)
          )
        )
      await tx
        .update(schema.apikeys)
        .set({ enabled: false, updatedAt: now })
        .where(
          and(
            eq(schema.apikeys.referenceId, actor.organization.id),
            inArray(schema.apikeys.id, keyIds)
          )
        )
    }
    if (cascade?.agents.length) {
      await tx
        .delete(schema.agentOwners)
        .where(
          and(
            eq(schema.agentOwners.organizationId, actor.organization.id),
            or(
              ...cascade.agents.map((agent) =>
                and(
                  eq(schema.agentOwners.workspaceId, agent.workspaceId),
                  eq(schema.agentOwners.agentName, agent.agentName)
                )
              )
            )
          )
        )
    }
    const cleanupId = reduction ? `cleanup-${randomUUID()}` : undefined
    if (cleanupId && cascade) {
      await tx.insert(schema.cleanupJobs).values({
        id: cleanupId,
        operation: "role_reduce",
        organizationId: actor.organization.id,
        payload: {
          api_key_count: cascade.keys.length,
          operation: "role_reduce",
          owned_agent_count: cascade.agents.length,
          owned_agents: cascade.agents.map((agent) => ({
            agent_name: agent.agentName,
            workspace_id: agent.workspaceId,
          })),
          revokes_authorization_first: true,
          role_id: id,
        },
        targetId: id,
        targetType: "role",
        workspaceId: workspace?.id,
      })
    }
    await tx.insert(schema.auditEvents).values({
      actorId: actor.userId,
      actorType: "user",
      action,
      after: [
        { field: "name", value: input.name },
        { field: "state", value: `${grants.length} Permission Grants` },
      ],
      automaticCascade: reduction,
      before: before
        ? [
            { field: "name", value: before.name },
            { field: "state", value: `${oldGrants.length} Permission Grants` },
          ]
        : null,
      category: "role",
      cleanupJobId: cleanupId,
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(actor.requestHeaders, getAuth().options),
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: id,
      targetType: "role",
      userAgent: actor.requestHeaders.get("user-agent"),
      workspaceId: workspace?.id,
    })
    return workspace
      ? { cleanupId, roleId: id, organizationId: actor.organization.id, workspaceId: workspace.id }
      : { cleanupId, roleId: id, organizationId: actor.organization.id }
  })
}

async function loadRoleUsers(scope: RoleManagement, roleId: string) {
  const editor = await loadRoleEditor(scope, roleId)
  if (!editor.role) {
    return
  }
  const users = await getDB()
    .select({
      email: schema.users.email,
      memberId: schema.members.id,
      name: schema.users.name,
      assigned: sql<boolean>`EXISTS (
        SELECT 1 FROM member_roles
        WHERE member_roles.member_id = ${sql.raw('"members"."id"')}
          AND member_roles.role_id = ${roleId}
          AND member_roles.organization_id = ${scope.actor.organization.id}
      )`,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.members.organizationId, scope.actor.organization.id),
        isNull(schema.members.disabledAt)
      )
    )
    .orderBy(asc(schema.users.name), asc(schema.users.email))

  return { ...editor, users }
}

async function assignRoleUsers(scope: RoleManagement, roleId: string, memberIds: string[]) {
  const { actor, workspace } = scope
  const selected = [...new Set(memberIds)]
  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.organization.id))
      .for("update")

    const [role] = await tx
      .select({ systemRole: schema.roleScopes.systemRole })
      .from(schema.roleScopes)
      .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
      .for("update")
      .limit(1)
    if (!role) return { error: "not-found" as const }

    const [authority] = await tx
      .select({ systemRole: schema.roleScopes.systemRole })
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
          eq(schema.roleScopes.immutable, true),
          workspace
            ? sql`(
                (${schema.roleScopes.systemRole} = 'superadmin' AND
                  ${schema.roleScopes.workspaceId} IS NULL) OR
                (${schema.roleScopes.systemRole} = 'workspace_admin' AND
                  ${schema.roleScopes.workspaceId} = ${workspace.id})
              )`
            : and(
                eq(schema.roleScopes.systemRole, "superadmin"),
                isNull(schema.roleScopes.workspaceId)
              )
        )
      )
      .orderBy(sql`${schema.roleScopes.systemRole} = 'superadmin' DESC`)
      .limit(1)
    if (
      !authority ||
      (role.systemRole === "workspace_admin" && authority.systemRole !== "superadmin")
    ) {
      await tx
        .insert(schema.auditEvents)
        .values(
          roleAudit(
            actor,
            workspace ? "workspace_role.assign" : "role.assign",
            roleId,
            "denied",
            workspace?.id
          )
        )
      return { error: "forbidden" as const }
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
    if (members.length !== selected.length) return { error: "invalid" as const }
    if (role.systemRole === "superadmin" && selected.length === 0) {
      return { error: "final-superadmin" as const }
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
      actorId: actor.userId,
      actorType: "user",
      action: workspace ? "workspace_role.assign" : "role.assign",
      after: selected.map((memberId) => ({ field: "member_id" as const, value: memberId })),
      automaticCascade: false,
      before: current.map(({ memberId }) => ({ field: "member_id" as const, value: memberId })),
      category: "role",
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(actor.requestHeaders, getAuth().options),
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: roleId,
      targetType: "role",
      userAgent: actor.requestHeaders.get("user-agent"),
      workspaceId: workspace?.id,
    })
    return workspace
      ? { organizationId: actor.organization.id, workspaceId: workspace.id }
      : { organizationId: actor.organization.id }
  })
}

async function removeRole(scope: RoleManagement, roleId: string) {
  const { actor, workspace } = scope
  return getDB().transaction(async (tx) => {
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.organization.id))
      .for("update")

    const [role] = await tx
      .select({ immutable: schema.roleScopes.immutable, name: schema.roleScopes.displayName })
      .from(schema.roleScopes)
      .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
      .for("update")
      .limit(1)
    if (!role) return { error: "not-found" as const }
    if (role.immutable) {
      await tx
        .insert(schema.auditEvents)
        .values(
          roleAudit(
            actor,
            workspace ? "workspace_role.delete" : "role.delete",
            roleId,
            "denied",
            workspace?.id
          )
        )
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
      .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
      .limit(1)
    const blockers = [
      ...(references?.users ? [`${references.users} Users`] : []),
      ...(references?.teams ? [`${references.teams} Teams`] : []),
      ...(references?.invitations ? [`${references.invitations} pending Invitations`] : []),
      ...(references?.socialDefaults
        ? [`${references.socialDefaults} Social Admission defaults`]
        : []),
    ]
    if (blockers.length) return { error: "referenced" as const, references: blockers }

    const [authorized] = await tx
      .select({ systemRole: schema.roleScopes.systemRole })
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
          eq(schema.roleScopes.immutable, true),
          workspace
            ? sql`(
                (${schema.roleScopes.systemRole} = 'superadmin' AND
                  ${schema.roleScopes.workspaceId} IS NULL) OR
                (${schema.roleScopes.systemRole} = 'workspace_admin' AND
                  ${schema.roleScopes.workspaceId} = ${workspace.id})
              )`
            : and(
                eq(schema.roleScopes.systemRole, "superadmin"),
                isNull(schema.roleScopes.workspaceId)
              )
        )
      )
      .limit(1)
    if (!authorized) {
      await tx
        .insert(schema.auditEvents)
        .values(
          roleAudit(
            actor,
            workspace ? "workspace_role.delete" : "role.delete",
            roleId,
            "denied",
            workspace?.id
          )
        )
      return { error: "forbidden" as const }
    }

    await tx
      .delete(schema.invitationRoles)
      .where(
        and(
          eq(schema.invitationRoles.organizationId, actor.organization.id),
          eq(schema.invitationRoles.roleId, roleId)
        )
      )
    await tx
      .delete(schema.roleScopes)
      .where(and(roleScope(scope), eq(schema.roleScopes.roleId, roleId)))
    await tx
      .delete(schema.organizationRoles)
      .where(
        and(
          eq(schema.organizationRoles.organizationId, actor.organization.id),
          eq(schema.organizationRoles.id, roleId)
        )
      )
    await tx.insert(schema.auditEvents).values({
      actorId: actor.userId,
      actorType: "user",
      action: workspace ? "workspace_role.delete" : "role.delete",
      automaticCascade: false,
      before: [{ field: "name", value: role.name }],
      category: "role",
      id: `audit-${randomUUID()}`,
      interface: "web",
      ipAddress: getIp(actor.requestHeaders, getAuth().options),
      organizationId: actor.organization.id,
      result: "succeeded",
      targetId: roleId,
      targetType: "role",
      userAgent: actor.requestHeaders.get("user-agent"),
      workspaceId: workspace?.id,
    })
    return workspace
      ? { organizationId: actor.organization.id, workspaceId: workspace.id }
      : { organizationId: actor.organization.id }
  })
}

export async function listWorkspaceRoles(orgSlug: string, workspaceSlug: string) {
  "use cache: private"
  cacheLife({ stale: 30 })
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (!scope?.workspace) return
  cacheTag(
    `organization:${scope.actor.organization.id}:workspace:${scope.workspace.id}:roles`,
    `organization:${scope.actor.organization.id}:workspace:${scope.workspace.id}:user:${scope.actor.userId}:roles`
  )
  return {
    organization: scope.actor.organization,
    roles: await listRoles(scope),
    superadmin: scope.superadmin,
    workspace: scope.workspace,
  }
}

export async function getWorkspaceRoleEditorData(
  orgSlug: string,
  workspaceSlug: string,
  roleId?: string
): Promise<WorkspaceRoleEditorData | undefined> {
  "use cache: private"
  cacheLife({ stale: 30 })
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (!scope?.workspace) return
  cacheTag(
    `organization:${scope.actor.organization.id}:workspace:${scope.workspace.id}:roles`,
    `organization:${scope.actor.organization.id}:workspace:${scope.workspace.id}:user:${scope.actor.userId}:roles`,
    ...(roleId
      ? [
          `organization:${scope.actor.organization.id}:workspace:${scope.workspace.id}:role:${roleId}`,
        ]
      : [])
  )
  return {
    ...(await loadRoleEditor(scope, roleId)),
    superadmin: scope.superadmin,
    workspace: scope.workspace,
  }
}

export async function previewWorkspaceRole(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string,
  name: string,
  inputs: RoleGrantInput[],
  updatedAt: string
): Promise<RoleImpact | { error: "forbidden" | "invalid" | "not-found" | "stale" }> {
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  return scope?.workspace
    ? previewRole(scope, roleId, name, inputs, updatedAt)
    : { error: "forbidden" }
}

export async function saveWorkspaceRole(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string | undefined,
  input: { name: string; grants: RoleGrantInput[]; updatedAt?: string; previewFingerprint?: string }
) {
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (scope?.workspace) return saveRole(scope, roleId, input)
  const denied = await getDeniedWorkspaceRoleActor(orgSlug, workspaceSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(
        roleAudit(
          denied,
          roleId ? "workspace_role.update" : "workspace_role.create",
          roleId ?? "new",
          "denied",
          denied.workspace.id
        )
      )
  }
  return { error: "forbidden" as const }
}

export async function getWorkspaceRoleUsers(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string
) {
  "use cache: private"
  cacheLife({ stale: 30 })
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (!scope?.workspace) return
  const editor = await loadRoleUsers(scope, roleId)
  return editor
    ? { ...editor, superadmin: scope.superadmin, workspace: scope.workspace }
    : undefined
}

export async function assignWorkspaceRoleUsers(
  orgSlug: string,
  workspaceSlug: string,
  roleId: string,
  memberIds: string[]
) {
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (scope?.workspace) return assignRoleUsers(scope, roleId, memberIds)
  const denied = await getDeniedWorkspaceRoleActor(orgSlug, workspaceSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(denied, "workspace_role.assign", roleId, "denied", denied.workspace.id))
  }
  return { error: "forbidden" as const }
}

export async function deleteWorkspaceRole(orgSlug: string, workspaceSlug: string, roleId: string) {
  const scope = await resolveRoleManagement(orgSlug, workspaceSlug)
  if (scope?.workspace) return removeRole(scope, roleId)
  const denied = await getDeniedWorkspaceRoleActor(orgSlug, workspaceSlug)
  if (denied) {
    await getDB()
      .insert(schema.auditEvents)
      .values(roleAudit(denied, "workspace_role.delete", roleId, "denied", denied.workspace.id))
  }
  return { error: "forbidden" as const }
}
