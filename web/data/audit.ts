import "server-only"

import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { getWorkspaceScope } from "@/data/workspaces"
import { getAuditEvent, listAuditEvents, type ListAuditEventsData } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listOrganizationAuditEvents(
  orgSlug: string,
  query: NonNullable<ListAuditEventsData["query"]>
) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  await activateOrganization(scope.organization.id)
  const result = await listAuditEvents({
    client: getGatewayServerClient(),
    query,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data
}

export async function getOrganizationAuditEvent(orgSlug: string, eventId: string) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  await activateOrganization(scope.organization.id)
  return getAuditEvent({
    client: getGatewayServerClient(),
    path: { eventId },
  })
}

export async function listWorkspaceAuditEvents(
  orgSlug: string,
  workspaceSlug: string,
  query: NonNullable<ListAuditEventsData["query"]>
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (
    scope.scope.kind !== "ready" ||
    scope.kind !== "ready" ||
    (!scope.scope.organization.superadmin && !scope.workspace.can_administer)
  ) {
    return
  }

  const audit = await listAuditEvents({
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    query,
  })
  if (audit.error) {
    throw new Error(audit.error.message)
  }

  return {
    audit: audit.data,
    workspace: { id: scope.workspace.id, name: scope.workspace.name },
  }
}

export async function getWorkspaceAuditEvent(
  orgSlug: string,
  workspaceSlug: string,
  eventId: string
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (
    scope.scope.kind !== "ready" ||
    scope.kind !== "ready" ||
    (!scope.scope.organization.superadmin && !scope.workspace.can_administer)
  ) {
    return
  }

  return getAuditEvent({
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    path: { eventId },
  })
}
