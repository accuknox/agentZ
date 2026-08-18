import "server-only"

import { inArray } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"
import { activateOrganization, resolveOrganizationSlug } from "@/data/organizations"
import type { EventsChartData } from "@/data/types"
import { getWorkspaceScope } from "@/data/workspaces"
import {
  listEventTrailEvents,
  type EventTrailEvent,
  type ListEventTrailEventsData,
} from "@/lib/gateway/client"
import {
  zEventTrailFilter,
  zEventTrailFilterField,
  zPageTokenQuery,
} from "@/lib/gateway/client/zod.gen"
import { dayjs } from "@/lib/format"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

const chartSourceLimit = 100
const maxChartPoints = 25
type EventTrailOptions = Parameters<typeof listEventTrailEvents>[0]

export const eventTrailQuerySchema = z.object({
  filters: z
    .string()
    .transform((value) => z.array(zEventTrailFilter).parse(JSON.parse(value)))
    .optional()
    .default(() => {
      const now = dayjs()
      return [
        {
          field: zEventTrailFilterField.enum.created_at,
          values: [
            now.subtract(24, "hour").startOf("day").toISOString(),
            now.endOf("day").toISOString(),
          ],
        },
      ]
    }),
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

async function loadEventTrail(
  body: ListEventTrailEventsData["body"],
  client: NonNullable<EventTrailOptions["client"]>,
  headers?: EventTrailOptions["headers"]
) {
  const [page, chart] = await Promise.all([
    listEventTrailEvents({ body, client, headers }),
    listEventTrailEvents({
      body: { filters: body.filters, limit: chartSourceLimit },
      client,
      headers,
    }),
  ])
  if (page.error) {
    throw new Error(page.error.message)
  }
  if (chart.error) {
    throw new Error(chart.error.message)
  }

  return {
    actorImages: await getEventTrailActorImages(
      page.data.filter_options.actors.flatMap((actor) => (actor.id ? [actor.id] : []))
    ),
    chart: eventTrailChart(chart.data.events),
    eventTrail: page.data,
  }
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
  return loadEventTrail(body, getGatewayServerClient())
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

  const headers = { "X-AgentZ-Workspace-ID": scope.workspace.id }
  const events = await loadEventTrail(body, getGatewayServerClient(scope.workspace.id), headers)

  return {
    ...events,
    workspace: { name: scope.workspace.name },
  }
}

function eventTrailChart(events: EventTrailEvent[]): EventsChartData {
  const buckets = new Map<number, number>()
  for (const event of events) {
    const minute = dayjs(event.created_at).startOf("minute").valueOf()
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1)
  }

  return {
    points: [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, maxChartPoints)
      .map(([minute, count]) => ({
        label: dayjs(minute).format("MMM D, h:mm A"),
        count,
      })),
    total: events.length,
  }
}
