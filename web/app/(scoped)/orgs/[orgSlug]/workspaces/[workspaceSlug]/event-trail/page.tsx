import type { ListEventTrailEventsData } from "@/lib/gateway/client"
import {
  EventTrailEvents,
  eventTrailQuerySchema,
} from "@/app/(scoped)/orgs/[orgSlug]/(organization)/event-trail/event-trail-events"
import { AdministrationState } from "@/components/administration"
import { listWorkspaceEventTrailEvents } from "@/data/event-trail"

export const unstable_instant = false

export default async function WorkspaceEventTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug, workspaceSlug }, raw] = await Promise.all([params, searchParams])
  const filters = eventTrailQuerySchema.parse(raw)
  const query = {
    ...filters,
    limit: 50,
    workspace_id: undefined,
  } satisfies NonNullable<ListEventTrailEventsData["query"]>
  const result = await listWorkspaceEventTrailEvents(orgSlug, workspaceSlug, query)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }

  const basePath = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/event-trail`
  return (
    <EventTrailEvents
      eventTrail={result.eventTrail}
      basePath={basePath}
      query={query}
      workspace={result.workspace}
    />
  )
}
