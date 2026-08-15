import "server-only"

import { inArray } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"
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

async function getEventTrailActorImages(actorIds: string[]) {
  if (!actorIds.length) return {}

  const users = await getDB()
    .select({ id: schema.users.id, image: schema.users.image })
    .from(schema.users)
    .where(inArray(schema.users.id, actorIds))

  return Object.fromEntries(users.flatMap((user) => (user.image ? [[user.id, user.image]] : [])))
}

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

  return {
    actorImages: await getEventTrailActorImages(
      result.data.filter_options.actors.flatMap((actor) => (actor.id ? [actor.id] : []))
    ),
    eventTrail: result.data,
  }
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
    (!scope.scope.organization.superadmin && !scope.workspace.capabilities.administer)
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
    actorImages: await getEventTrailActorImages(
      eventTrail.data.filter_options.actors.flatMap((actor) => (actor.id ? [actor.id] : []))
    ),
    eventTrail: eventTrail.data,
    workspace: { name: scope.workspace.name },
  }
}
