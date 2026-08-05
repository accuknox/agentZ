"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"

export default function Error({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="flex min-w-0 flex-1 p-4 md:p-6">
      <AdministrationState
        actions={<Button onClick={reset}>Try Again</Button>}
        description="Settings could not be loaded. Retry the request or return after the service recovers."
        kind="failed"
        title="Settings unavailable"
      />
    </main>
  )
}
