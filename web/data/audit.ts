import "server-only"

import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
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
