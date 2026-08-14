import "server-only"

import { randomUUID } from "node:crypto"
import { cache } from "react"
import { and, eq, isNull } from "drizzle-orm"
import {
  createWorkspace,
  listMcpConnections,
  listSandboxes,
  listWorkspaceInheritedResources,
  listWorkspaceMemberCandidates,
  listWorkspaces,
  replaceWorkspaceInheritedResources,
  resolveWorkspaceSlug,
  retryWorkspace,
  type CreateWorkspaceRequest,
  type InheritedResourceType,
  type Workspace,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import {
  activateOrganization,
  getOrganizationSession,
  resolveOrganizationSlug,
} from "@/data/organizations"
import { getDB, schema } from "@/db"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"

export const getWorkspaceDirectory = cache(async (orgSlug: string) => {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return { scope }
  }
  if (!scope.organization.hasAccess) {
    return { kind: "zero-access" as const, scope }
  }

  await activateOrganization(scope.organization.id)
  const client = getGatewayServerClient()
  const workspaces: Workspace[] = []
  let pageToken: string | undefined
  let canCreate = false
  let canEnterOrganization = false
  do {
    const result = await listWorkspaces({
      client,
      query: { limit: 200, page_token: pageToken },
    })
    if (result.error) throw new Error(result.error.message)
    workspaces.push(...result.data.workspaces)
    canCreate = result.data.can_create
    canEnterOrganization = result.data.can_enter_organization
    pageToken = result.data.next_page_token || undefined
  } while (pageToken)

  return {
    directory: {
      can_create: canCreate,
      can_enter_organization: canEnterOrganization,
      next_page_token: "",
      workspaces,
    },
    scope,
  }
})

export async function getWorkspacePage(orgSlug: string, pageToken?: string) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || !scope.organization.hasAccess) return { scope }

  await activateOrganization(scope.organization.id)
  const result = await listWorkspaces({
    client: getGatewayServerClient(),
    query: { limit: 50, page_token: pageToken },
  })
  if (result.error) throw new Error(result.error.message)
  return { directory: result.data, scope }
}

export const getWorkspaceScope = cache(async (orgSlug: string, workspaceSlug: string) => {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return { scope }
  }
  if (!scope.organization.hasAccess) {
    return { scope }
  }

  await activateOrganization(scope.organization.id)
  const [directoryResult, workspace] = await Promise.all([
    getWorkspaceDirectory(orgSlug),
    resolveWorkspaceSlug({
      client: getGatewayServerClient(),
      path: { workspaceSlug },
    }),
  ])
  if (!directoryResult.directory) throw new Error("workspace directory is unavailable")
  if (workspace.response?.status === 404) {
    return { directory: directoryResult.directory, kind: "not-found" as const, scope }
  }
  if (workspace.error) {
    throw new Error(workspace.error.message)
  }

  return {
    directory: directoryResult.directory,
    kind: "ready" as const,
    retired: workspace.data.slug !== workspaceSlug,
    scope,
    workspace: workspace.data,
  }
})

export async function getWorkspaceCreation(orgSlug: string) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || !scope.organization.superadmin) {
    return { scope }
  }

  await activateOrganization(scope.organization.id)
  const client = getGatewayServerClient()
  const [members, skills, sandboxes, mcps, providers] = await Promise.all([
    listWorkspaceMemberCandidates({ client }),
    listImmutableSkillsCachedQuery(),
    (async () => {
      const names: string[] = []
      let pageToken: string | undefined
      do {
        const result = await listSandboxes({
          client,
          query: { limit: 200, page_token: pageToken },
        })
        if (result.error) return result
        names.push(...result.data.sandboxes.map(({ name }) => name))
        pageToken = result.data.next_page_token || undefined
      } while (pageToken)
      return { data: names, error: undefined }
    })(),
    (async () => {
      const names: string[] = []
      let pageToken: string | undefined
      do {
        const result = await listMcpConnections({
          client,
          query: { limit: 200, page_token: pageToken },
        })
        if (result.error) return result
        names.push(...result.data.mcp_connections.map(({ name }) => name))
        pageToken = result.data.next_page_token || undefined
      } while (pageToken)
      return { data: names, error: undefined }
    })(),
    listInferenceProvidersCachedQuery(),
  ])
  if (members.error) throw new Error(members.error.message)
  if (skills.error) throw new Error(skills.error.message)
  if (sandboxes.error) throw new Error(sandboxes.error.message)
  if (mcps.error) throw new Error(mcps.error.message)
  if (providers.error) throw new Error(providers.error.message)

  return {
    candidates: members.data.members,
    resources: {
      skills: skills.skills.map(({ name }) => name),
      sandboxes: sandboxes.data,
      mcp_connections: mcps.data,
      inference_providers: providers.providers.map(({ id }) => id),
    },
    scope,
  }
}

export async function getWorkspaceInheritedResources(
  orgSlug: string,
  workspaceSlug: string,
  resourceType: InheritedResourceType
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (
    scope.scope.kind !== "ready" ||
    !scope.scope.organization.superadmin ||
    scope.kind !== "ready"
  ) {
    return
  }
  const result = await listWorkspaceInheritedResources({
    client: getGatewayServerClient(),
    path: { resourceType, workspaceId: scope.workspace.id },
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return { ...scope, resources: result.data.resources }
}

export async function replaceWorkspaceInheritedResourceSelection(
  orgSlug: string,
  workspaceSlug: string,
  resourceType: InheritedResourceType,
  names: string[]
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (
    scope.scope.kind !== "ready" ||
    !scope.scope.organization.superadmin ||
    scope.kind !== "ready"
  ) {
    return
  }
  return replaceWorkspaceInheritedResources({
    body: { names },
    client: getGatewayServerClient(),
    path: { resourceType, workspaceId: scope.workspace.id },
  })
}

export async function provisionWorkspace(orgSlug: string, request: CreateWorkspaceRequest) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || !scope.organization.superadmin) {
    return
  }

  await activateOrganization(scope.organization.id)
  return createWorkspace({
    body: request,
    client: getGatewayServerClient(),
  })
}

export async function retryWorkspaceProvisioning(orgSlug: string, workspaceId: string) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready" || !scope.organization.superadmin) {
    return
  }

  await activateOrganization(scope.organization.id)
  return retryWorkspace({
    client: getGatewayServerClient(),
    path: { workspaceId },
  })
}

export async function updateWorkspaceName(orgSlug: string, workspaceId: string, name: string) {
  const organizationSession = await getOrganizationSession()
  if (!organizationSession) return { error: "forbidden" as const }

  return getDB().transaction(async (tx) => {
    const [workspace] = await tx
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        organizationId: schema.workspaces.organizationId,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.workspaces.organizationId)
      )
      .where(
        and(
          eq(schema.organizations.slug, orgSlug),
          eq(schema.workspaces.id, workspaceId),
          isNull(schema.workspaces.deletedAt)
        )
      )
      .for("update")
      .limit(1)
    if (!workspace) return { error: "not-found" as const }

    const [superadmin] = await tx
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
          eq(schema.members.userId, organizationSession.session.user.id),
          eq(schema.members.organizationId, workspace.organizationId),
          isNull(schema.members.disabledAt),
          eq(schema.roleScopes.systemRole, "superadmin"),
          eq(schema.roleScopes.immutable, true)
        )
      )
      .limit(1)

    const eventTrail = {
      action: "workspace.modify",
      actorId: organizationSession.session.user.id,
      actorType: "user" as const,
      after: [{ field: "name", value: name }],
      before: [{ field: "name", value: workspace.name }],
      category: "workspace" as const,
      id: `event-trail-${randomUUID()}`,
      organizationId: workspace.organizationId,
      result: superadmin ? ("succeeded" as const) : ("denied" as const),
      targetId: workspace.id,
      targetType: "workspace",
      workspaceId: workspace.id,
    } satisfies typeof schema.eventTrailEvents.$inferInsert

    if (!superadmin) {
      await tx.insert(schema.eventTrailEvents).values(eventTrail)
      return { error: "forbidden" as const }
    }
    if (workspace.name !== name) {
      await tx
        .update(schema.workspaces)
        .set({ name, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspace.id))
    }
    await tx.insert(schema.eventTrailEvents).values(eventTrail)
    return { organizationId: workspace.organizationId, workspaceId: workspace.id }
  })
}
