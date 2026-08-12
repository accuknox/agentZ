import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import { listOrganizationEventTrailEvents } from "@/data/event-trail"
import { EventTrailEvents, eventTrailQuerySchema } from "./event-trail-events"

export const unstable_instant = {
  prefetch: "runtime",
  // A build cannot carry a stable authenticated session; live requests retain
  // development validation against the real Organisation boundary.
  unstable_disableBuildValidation: true,
  samples: [
    {
      cookies: [],
      headers: [
        ["next-action", null],
        ["rsc", null],
        ["x-agentz-pathname", null],
      ],
      params: { catchAll: ["event trail"], orgSlug: "sample-organisation" },
      searchParams: {
        actor_id: null,
        actor_type: null,
        category: null,
        created_after: null,
        created_before: null,
        page_token: null,
        result: null,
        target_type: null,
        workspace_id: null,
      },
    },
  ],
}

export default async function EventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug }, raw] = await Promise.all([params, searchParams])
  const filters = eventTrailQuerySchema.parse(raw)
  const query = { ...filters, limit: 50 } satisfies NonNullable<ListEventTrailEventsData["query"]>
  const eventTrail = await listOrganizationEventTrailEvents(orgSlug, query)
  if (!eventTrail) {
    return null
  }

  return (
    <EventTrailEvents
      eventTrail={eventTrail}
      basePath={`/orgs/${orgSlug}/event-trail`}
      query={query}
    />
  )
}
