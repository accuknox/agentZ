import { RememberRoute } from "@/data/route-memory"
import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import { EventTrailEvents } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/event-trail/event-trail-events"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { eventTrailQuerySchema, listWorkspaceEventTrailEvents } from "@/data/event-trail"
import { RequestError } from "@/components/request-error"
import { EventTrailFilters } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/event-trail/event-trail-filters"

export const metadata = { title: "Event trail" }

export default async function WorkspaceEventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug, workspaceSlug }, raw] = await Promise.all([params, searchParams])
  const parsed = eventTrailQuerySchema.safeParse(raw)
  const search = parsed.success ? parsed.data : eventTrailQuerySchema.parse({})
  const body = {
    filters: search.filters,
    limit: 50,
    page_token: search.page_token,
  } satisfies ListEventTrailEventsData["body"]
  const result = parsed.success
    ? await listWorkspaceEventTrailEvents(orgSlug, workspaceSlug, body)
    : {
        error: {
          code: "invalid_request",
          message: "These event filters are invalid. Clear or change the filters to continue.",
        },
      }
  if (!result) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <AdministrationPageHeader title="Event trail" />
        <AdministrationState kind="forbidden" />
      </div>
    )
  }
  if (result.error) {
    return (
      <div className="flex min-w-0 flex-col">
        <AdministrationPageHeader title="Event trail" />
        <EventTrailFilters filters={body.filters} hideWorkspace />
        <RequestError
          resetFilters={
            result.error.code === "invalid_request" || result.error.code === "invalid_time_range"
          }
          className="p-4 md:p-6"
          title="Could not load event trail"
          error={result.error}
        />
      </div>
    )
  }

  return (
    <>
      <RememberRoute />
      <EventTrailEvents
        actorImages={result.actorImages}
        chart={result.chart}
        chartError={result.chartError}
        eventTrail={result.eventTrail}
        filters={body.filters}
        workspace={result.workspace}
      />
    </>
  )
}
