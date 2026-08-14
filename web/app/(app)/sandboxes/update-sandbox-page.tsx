import type { Metadata } from "next"
import type { UrlObject } from "node:url"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listInferencePoolsCachedQuery } from "@/data/inference-pool.queries"
import { SandboxWizard } from "./wizard"
import { AdministrationState } from "@/components/administration"

type UpdateSandboxPageProps = {
  basePath: string
  params: Promise<{
    name: string
  }>
  providersHref: UrlObject
  workspaceId?: string
}

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

export default async function UpdateSandboxPage({
  basePath,
  params,
  providersHref,
  workspaceId,
}: UpdateSandboxPageProps) {
  const { name } = await params

  return (
    <Suspense fallback={<UpdateSandboxSkeleton />}>
      <UpdateSandboxContent
        basePath={basePath}
        name={name}
        providersHref={providersHref}
        workspaceId={workspaceId}
      />
    </Suspense>
  )
}

async function UpdateSandboxContent({
  basePath,
  name,
  providersHref,
  workspaceId,
}: {
  basePath: string
  name: string
  providersHref: UrlObject
  workspaceId?: string
}) {
  const sandboxResult = listSandboxesCachedQuery({ limit: 200 }, workspaceId)
  const mcpResult = listMcpConnectionsCachedQuery({ limit: 200 }, workspaceId)
  const skillsResult = listImmutableSkillsCachedQuery(workspaceId)
  const providersResult = listInferenceProvidersCachedQuery(workspaceId)
  const poolsResult = workspaceId
    ? listInferencePoolsCachedQuery(workspaceId)
    : Promise.resolve({ pools: [], error: undefined })
  const [sandboxes, mcpConnections, skills, providers, pools] = await Promise.all([
    sandboxResult,
    mcpResult,
    skillsResult,
    providersResult,
    poolsResult,
  ])

  if (sandboxes.error || !sandboxes.sandboxes) {
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {sandboxes.error?.message ?? "Failed to load sandbox"}
      </div>
    )
  }

  const sandbox = sandboxes.sandboxes.find((item) => item.name === name)
  if (!sandbox) {
    notFound()
  }
  if (!sandbox.can_modify) {
    return <AdministrationState kind="forbidden" />
  }

  const mcpConnectionRefs = sandbox.mcp_connection_refs.map((ref) => ({
    scope: ref.scope,
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
    skills: sandbox.skills,
    inference: sandbox.inference,
  })

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <div className="min-w-0 px-4 pt-4 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-normal">Update sandbox</h1>
      </div>
      <SandboxWizard
        key={wizardKey}
        mode="update"
        providersHref={providersHref}
        scope={{ basePath, workspaceId }}
        initialName={sandbox.name}
        initialPackages={sandbox.packages ?? []}
        initialAllowedHosts={sandbox.allowed_hosts ?? []}
        initialMcpConnectionRefs={mcpConnectionRefs}
        initialSkills={sandbox.skills}
        initialInference={sandbox.inference}
        immutableSkills={skills.skills ?? []}
        inferenceProviders={providers.providers ?? []}
        inferencePools={pools.pools ?? []}
        mcpConnections={mcpConnections.mcpConnections ?? []}
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
