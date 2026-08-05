import "server-only"

import { cache } from "react"
import {
  createWorkspace,
  listWorkspaceMemberCandidates,
  listWorkspaces,
  resolveWorkspaceSlug,
  retryWorkspace,
  type CreateWorkspaceRequest,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"

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
  const result = await listWorkspaceMemberCandidates({ client: getGatewayServerClient() })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return { candidates: result.data.members, scope }
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
