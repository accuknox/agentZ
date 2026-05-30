import { Suspense } from "react"
import { notFound } from "next/navigation"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { EnvironmentWizard } from "../../wizard"

export default function UpdateEnvironmentPage({ params }: { params: Promise<{ name: string }> }) {
  return (
    <Suspense fallback={<UpdateEnvironmentSkeleton />}>
      {params.then(({ name }) => (
        <UpdateEnvironmentContent name={name} />
      ))}
    </Suspense>
  )
}

async function UpdateEnvironmentContent({ name }: { name: string }) {
  const [environmentResult, mcpResult] = await Promise.all([
    listEnvironmentsCachedQuery({ limit: 200 }),
    listMcpConnectionsCachedQuery({ limit: 200 }),
  ])

  if (environmentResult.error || !environmentResult.environments) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {environmentResult.error?.message ?? "Failed to load environment"}
      </div>
    )
  }

  const env = environmentResult.environments.find((e) => e.name === name)
  if (!env) {
    notFound()
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">Update environment</h1>
      </div>
      <EnvironmentWizard
        mode="update"
        initialName={env.name}
        initialPackages={env.packages ?? []}
        initialAllowedHosts={env.allowed_hosts ?? []}
        initialMcpConnectionRefs={env.mcp_connection_refs.map((ref) => ref.name)}
        mcpConnections={mcpResult.mcpConnections ?? []}
      />
    </main>
  )
}

function UpdateEnvironmentSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <div className="h-8 w-56 rounded-md bg-muted/20" />
      </div>
      <div className="h-96 rounded-md bg-muted/20" />
    </main>
  )
}
