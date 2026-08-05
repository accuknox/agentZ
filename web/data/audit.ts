import "server-only"

import { getAuditEvent, listAuditEvents, type ListAuditEventsData } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listOrganizationAuditEvents(
  query: NonNullable<ListAuditEventsData["query"]>
) {
  const result = await listAuditEvents({
    client: getGatewayServerClient(),
    query,
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data
}

export async function getOrganizationAuditEvent(eventId: string) {
  return getAuditEvent({
    client: getGatewayServerClient(),
    path: { eventId },
  })
}
