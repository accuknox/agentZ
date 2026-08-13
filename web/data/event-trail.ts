import "server-only"

import { z } from "zod"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import { getWorkspaceScope } from "@/data/workspaces"
import { listEventTrailEvents, type ListEventTrailEventsData } from "@/lib/gateway/client"
import { zEventTrailFilter, zPageTokenQuery } from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export const eventTrailQuerySchema = z.object({
  filters: z
    .string()
    .transform((value) => z.array(zEventTrailFilter).parse(JSON.parse(value)))
    .optional(),
  page_token: zPageTokenQuery.optional(),
  token_stack: z.string().optional(),
})

export async function listOrganizationEventTrailEvents(
  orgSlug: string,
  body: ListEventTrailEventsData["body"]
) {
  const scope = await resolveOrganizationSlug(orgSlug)
  if (scope.kind !== "ready") {
    return
  }

  await activateOrganization(scope.organization.id)
  const result = await listEventTrailEvents({
    body,
    client: getGatewayServerClient(),
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return result.data
}

export async function listWorkspaceEventTrailEvents(
  orgSlug: string,
  workspaceSlug: string,
  body: ListEventTrailEventsData["body"]
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
    body,
    client: getGatewayServerClient(scope.workspace.id),
    headers: { "X-AgentZ-Workspace-ID": scope.workspace.id },
  })
  if (eventTrail.error) {
    throw new Error(eventTrail.error.message)
  }

  return {
    eventTrail: eventTrail.data,
    workspace: { name: scope.workspace.name },
  }
}
