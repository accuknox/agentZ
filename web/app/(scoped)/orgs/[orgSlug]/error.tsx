"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
      <AdministrationState actions={<Button onClick={reset}>Try again</Button>} kind="failed" />
    </div>
  )
}
