"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { EventTrailDrawer } from "../../event-trail-drawer"

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <EventTrailDrawer>
      <AdministrationState actions={<Button onClick={reset}>Try again</Button>} kind="failed" />
    </EventTrailDrawer>
  )
}
