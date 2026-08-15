import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import { EventTrailEvents } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/event-trail/event-trail-events"
import { AdministrationState } from "@/components/administration"
import { eventTrailQuerySchema, listWorkspaceEventTrailEvents } from "@/data/event-trail"

export const unstable_instant = false

export const metadata = { title: "Event trail" }

export default async function WorkspaceEventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug, workspaceSlug }, raw] = await Promise.all([params, searchParams])
  const search = eventTrailQuerySchema.parse(raw)
  const body = {
    filters: search.filters ?? [],
    limit: 50,
    page_token: search.page_token,
  } satisfies ListEventTrailEventsData["body"]
  const result = await listWorkspaceEventTrailEvents(orgSlug, workspaceSlug, body)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <EventTrailEvents
      actorImages={result.actorImages}
      eventTrail={result.eventTrail}
      filters={body.filters}
      workspace={result.workspace}
    />
  )
}
