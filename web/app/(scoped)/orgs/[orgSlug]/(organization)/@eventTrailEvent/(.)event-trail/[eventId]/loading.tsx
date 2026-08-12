import { Skeleton } from "@/components/ui/skeleton"
import { EventTrailDrawer } from "../../event-trail-drawer"

export default function Loading() {
  return (
    <EventTrailDrawer>
      <div aria-label="Loading event trail event" role="status">
        <Skeleton className="min-h-96 w-full" />
        <span className="sr-only">Loading event trail event…</span>
      </div>
    </EventTrailDrawer>
  )
}
