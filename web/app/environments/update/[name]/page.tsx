import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { EnvironmentWizard } from "../../wizard"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>
}): Promise<Metadata> {
  const { name } = await params

  return {
    title: `Edit Environment: ${name}`,
  }
}

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
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {environmentResult.error?.message ?? "Failed to load environment"}
      </div>
    )
  }

  const env = environmentResult.environments.find((e) => e.name === name)
  if (!env) {
    notFound()
  }

  const mcpConnectionRefs = env.mcp_connection_refs.map((ref) => ({
    name: ref.name,
    tools: (ref.tools ?? []).map((tool) => ({
      name: tool.name,
      requireConsent: tool.require_consent,
    })),
  }))

  const wizardKey = JSON.stringify({
    name: env.name,
    packages: env.packages ?? [],
    allowedHosts: env.allowed_hosts ?? [],
    mcpConnectionRefs,
  })

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">Update environment</h1>
      </div>
      <EnvironmentWizard
        key={wizardKey}
        mode="update"
        initialName={env.name}
        initialPackages={env.packages ?? []}
        initialAllowedHosts={env.allowed_hosts ?? []}
        initialMcpConnectionRefs={mcpConnectionRefs}
        mcpConnections={mcpResult.mcpConnections ?? []}
      />
    </main>
  )
}

function UpdateEnvironmentSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <div className="bg-muted/20 h-8 w-56 rounded-md" />
      </div>
      <div className="bg-muted/20 h-96 rounded-md" />
    </main>
  )
}
