"use client"

import { AdministrationState } from "@/components/administration"
import { EventTrailDrawer } from "../../event-trail-drawer"

export default function ErrorPage() {
  return (
    <EventTrailDrawer>
      <AdministrationState kind="failed" />
    </EventTrailDrawer>
  )
}
