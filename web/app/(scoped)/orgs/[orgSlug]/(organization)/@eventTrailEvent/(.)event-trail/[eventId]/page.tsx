import { EventTrailEventDetail } from "../../../event-trail/event-trail-event"
import { EventTrailDrawer } from "../../event-trail-drawer"

// Next 16.2 cannot validate runtime samples for intercepted dynamic segments;
// the canonical detail route validates the same server-rendered content.
export const unstable_instant = false

export default async function InterceptedEventTrailEventPage({
  params,
}: {
  params: Promise<{ eventId: string; orgSlug: string }>
}) {
  const { eventId, orgSlug } = await params
  return (
    <EventTrailDrawer>
      <EventTrailEventDetail compact eventId={eventId} orgSlug={orgSlug} />
    </EventTrailDrawer>
  )
}
