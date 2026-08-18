import { Suspense } from "react"
import { redirect } from "next/navigation"
import { rootOrganizationPath } from "@/data/organizations"

export default function RootPage() {
  return (
    <Suspense fallback={null}>
      <RootRedirect />
    </Suspense>
  )
}

async function RootRedirect(): Promise<never> {
  redirect(await rootOrganizationPath())
}
