import type { Metadata } from "next"
import { Suspense } from "react"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { defaultEnvironmentPackages } from "@/data/environment-defaults"
import { EnvironmentWizard } from "../wizard"

export const metadata: Metadata = {
  title: "New Environment",
}

export default function NewEnvironmentPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">New environment</h1>
      </div>
      <Suspense fallback={<WizardSkeleton />}>
        <NewEnvironmentWizard />
      </Suspense>
    </main>
  )
}

async function NewEnvironmentWizard() {
  const result = await listMcpConnectionsCachedQuery({ limit: 200 })
  return (
    <EnvironmentWizard
      mode="create"
      initialPackages={[...defaultEnvironmentPackages]}
      mcpConnections={result.mcpConnections ?? []}
    />
  )
}

function WizardSkeleton() {
  return <div className="bg-muted/20 h-96 rounded-md" />
}
