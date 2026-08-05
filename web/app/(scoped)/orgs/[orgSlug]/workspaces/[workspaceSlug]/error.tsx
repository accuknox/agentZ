"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <AdministrationState
      actions={<Button onClick={reset}>Try again</Button>}
      description="The Workspace could not be loaded. Try again."
      kind="failed"
      title="Unable to load Workspace"
    />
  )
}
