"use client"

import { AdministrationState } from "@/components/administration"

export default function ErrorPage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
      <AdministrationState kind="failed" />
    </div>
  )
}
