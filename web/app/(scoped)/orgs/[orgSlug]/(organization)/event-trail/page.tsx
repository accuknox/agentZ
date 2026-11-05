import { RememberRoute } from "@/data/route-memory"
import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import { eventTrailQuerySchema, listOrganizationEventTrailEvents } from "@/data/event-trail"
import { EventTrailEvents } from "./event-trail-events"
import { AdministrationPageHeader } from "@/components/administration"
import { RequestError } from "@/components/request-error"
import { EventTrailFilters } from "./event-trail-filters"

export const metadata = { title: "Event trail" }

export default async function EventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug }, raw] = await Promise.all([params, searchParams])
  const parsed = eventTrailQuerySchema.safeParse(raw)
  const search = parsed.success ? parsed.data : eventTrailQuerySchema.parse({})
  const body = {
    filters: search.filters,
    limit: 50,
    page_token: search.page_token,
  } satisfies ListEventTrailEventsData["body"]
  const eventTrail = parsed.success
    ? await listOrganizationEventTrailEvents(orgSlug, body)
    : {
        error: {
          code: "invalid_request",
          message: "These event filters are invalid. Clear or change the filters to continue.",
        },
      }
  if (!eventTrail) {
    return null
  }
  if (eventTrail.error) {
    return (
      <div className="flex min-w-0 flex-col">
        <AdministrationPageHeader title="Event trail" />
        <EventTrailFilters filters={body.filters} />
        <RequestError
          resetFilters={
            eventTrail.error.code === "invalid_request" ||
            eventTrail.error.code === "invalid_time_range"
          }
          className="p-4 md:p-6"
          title="Could not load event trail"
          error={eventTrail.error}
        />
      </div>
    )
  }

  return (
    <>
      <RememberRoute />
      <EventTrailEvents
        actorImages={eventTrail.actorImages}
        chart={eventTrail.chart}
        chartError={eventTrail.chartError}
        eventTrail={eventTrail.eventTrail}
        filters={body.filters}
      />
    </>
  )
}
