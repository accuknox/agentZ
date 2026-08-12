"use client"

import { AdministrationState } from "@/components/administration"

export default function Error() {
  return (
    <main className="flex min-w-0 flex-1 p-4 md:p-6">
      <AdministrationState kind="failed" title="Settings unavailable" />
    </main>
  )
}
