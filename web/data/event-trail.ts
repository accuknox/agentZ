import "server-only"

import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { getWorkspaceScope } from "@/data/workspaces"
import {
  getEventTrailEvent,
  listEventTrailEvents,
  type ListEventTrailEventsData,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listOrganizationEventTrailEvents(
  orgSlug: string,
  query: NonNullable<ListEventTrailEventsData["query"]>
) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  await activateOrganization(scope.organization.id)
  const result = await listEventTrailEvents({
    client: getGatewayServerClient(),
    query,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data
}

export async function getOrganizationEventTrailEvent(orgSlug: string, eventId: string) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  await activateOrganization(scope.organization.id)
  return getEventTrailEvent({
    client: getGatewayServerClient(),
    path: { eventId },
  })
}

export async function listWorkspaceEventTrailEvents(
  orgSlug: string,
  workspaceSlug: string,
  query: NonNullable<ListEventTrailEventsData["query"]>
) {
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (
    scope.scope.kind !== "ready" ||
    scope.kind !== "ready" ||
    (!scope.scope.organization.superadmin && !scope.workspace.can_administer)
  ) {
    return
  }

  const eventTrail = await listEventTrailEvents({
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    query,
  })
  if (eventTrail.error) {
    throw new Error(eventTrail.error.message)
  }

  return {
    eventTrail: eventTrail.data,
    workspace: { id: scope.workspace.id, name: scope.workspace.name },
  }
}

export async function getWorkspaceEventTrailEvent(
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

  return getEventTrailEvent({
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
    path: { eventId },
  })
}
