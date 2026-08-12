import { EventTrailEventDetail } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/event-trail/event-trail-event"

export const unstable_instant = false

export default async function WorkspaceEventTrailEventPage({
  params,
}: {
  params: Promise<{ eventId: string; orgSlug: string; workspaceSlug: string }>
}) {
  const { eventId, orgSlug, workspaceSlug } = await params
  return <EventTrailEventDetail eventId={eventId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
}
