import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { SandboxWizard } from "../../wizard"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>
}): Promise<Metadata> {
  const { name } = await params

  return {
    title: `Edit Sandbox: ${name}`,
  }
}

export default async function UpdateSandboxPage({ params }: { params: Promise<{ name: string }> }) {
  return (
    <Suspense fallback={<UpdateSandboxSkeleton />}>
      {params.then(({ name }) => (
        <UpdateSandboxContent name={name} />
      ))}
    </Suspense>
  )
}

async function UpdateSandboxContent({ name }: { name: string }) {
  const [sandboxResult, mcpResult] = await Promise.all([
    listSandboxesCachedQuery({ limit: 200 }),
    listMcpConnectionsCachedQuery({ limit: 200 }),
  ])

  if (sandboxResult.error || !sandboxResult.sandboxes) {
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {sandboxResult.error?.message ?? "Failed to load sandbox"}
      </div>
    )
  }

  const sandbox = sandboxResult.sandboxes.find((item) => item.name === name)
  if (!sandbox) {
    notFound()
  }

  const mcpConnectionRefs = sandbox.mcp_connection_refs.map((ref) => ({
    name: ref.name,
    tools: (ref.tools ?? []).map((tool) => ({
      name: tool.name,
      requireConsent: tool.require_consent,
    })),
  }))

  const wizardKey = JSON.stringify({
    name: sandbox.name,
    packages: sandbox.packages ?? [],
    allowedHosts: sandbox.allowed_hosts ?? [],
    mcpConnectionRefs,
  })

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <div className="min-w-0 px-4 pt-4 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-normal">Update sandbox</h1>
      </div>
      <SandboxWizard
        key={wizardKey}
        mode="update"
        initialName={sandbox.name}
        initialPackages={sandbox.packages ?? []}
        initialAllowedHosts={sandbox.allowed_hosts ?? []}
        initialMcpConnectionRefs={mcpConnectionRefs}
        mcpConnections={mcpResult.mcpConnections ?? []}
      />
    </main>
  )
}

function UpdateSandboxSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <div className="min-w-0 px-4 pt-4 sm:px-6">
        <div className="bg-muted/20 h-8 w-56 rounded-md" />
      </div>
      <div className="bg-muted/20 h-96" />
    </main>
  )
}
