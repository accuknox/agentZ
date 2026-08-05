"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { AuditDrawer } from "../../audit-drawer"

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <AuditDrawer>
      <AdministrationState actions={<Button onClick={reset}>Try again</Button>} kind="failed" />
    </AuditDrawer>
  )
}
