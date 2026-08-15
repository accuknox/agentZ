import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import { eventTrailQuerySchema, listOrganizationEventTrailEvents } from "@/data/event-trail"
import { EventTrailEvents } from "./event-trail-events"

export const unstable_instant = {
  prefetch: "runtime",
  // A build cannot carry a stable authenticated session; live requests retain
  // development validation against the real Organisation boundary.
  unstable_disableBuildValidation: true,
  samples: [
    {
      cookies: [],
      headers: [],
      params: { orgSlug: "sample-organisation" },
      searchParams: {
        filters: null,
        page_token: null,
        token_stack: null,
      },
    },
  ],
}

export const metadata = { title: "Event trail" }

export default async function EventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug }, raw] = await Promise.all([params, searchParams])
  const search = eventTrailQuerySchema.parse(raw)
  const body = {
    filters: search.filters,
    limit: 50,
    page_token: search.page_token,
  } satisfies ListEventTrailEventsData["body"]
  const eventTrail = await listOrganizationEventTrailEvents(orgSlug, body)
  if (!eventTrail) {
    return null
  }

  return (
    <EventTrailEvents
      actorImages={eventTrail.actorImages}
      chart={eventTrail.chart}
      eventTrail={eventTrail.eventTrail}
      filters={body.filters}
    />
  )
}
