import "server-only"

import { cache } from "react"
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
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"

export const getWorkspaceDirectory = cache(async (orgSlug: string) => {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return { scope }
  }

  await activateOrganization(scope.organization.id)
  const result = await listWorkspaces({ client: getGatewayServerClient() })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return { directory: result.data, scope }
})

export const getWorkspaceScope = cache(async (orgSlug: string, workspaceSlug: string) => {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return { scope }
  }

  await activateOrganization(scope.organization.id)
  const [directory, workspace] = await Promise.all([
    listWorkspaces({ client: getGatewayServerClient() }),
    resolveWorkspaceSlug({
      client: getGatewayServerClient(),
      path: { workspaceSlug },
    }),
  ])
  if (directory.error) {
    throw new Error(directory.error.message)
  }
  if (workspace.response?.status === 404) {
    return { directory: directory.data, kind: "not-found" as const, scope }
  }
  if (workspace.error) {
    throw new Error(workspace.error.message)
  }

  return {
    directory: directory.data,
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
