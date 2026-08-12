import { AdministrationState } from "@/components/administration"
import { EventTrailDrawer } from "../../event-trail-drawer"

export default function NotFound() {
  return (
    <EventTrailDrawer>
      <AdministrationState kind="not-found" title="Event Trail event not found" />
    </EventTrailDrawer>
  )
}
