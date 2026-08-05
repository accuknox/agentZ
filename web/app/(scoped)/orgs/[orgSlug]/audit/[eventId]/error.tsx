"use client"

import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <AdministrationState actions={<Button onClick={reset}>Try again</Button>} kind="failed" />
}
