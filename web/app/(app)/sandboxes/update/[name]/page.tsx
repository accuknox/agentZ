import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { sandboxAllowedHostSchema } from "@/data/schema"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { listSecretsCachedQuery } from "@/data/secret.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import type { SecretHost } from "@/lib/gateway/client"
import { SandboxWizard } from "../../wizard"

type UpdateSandboxPageProps = {
  params: Promise<{
    name: string
  }>
}

export async function generateMetadata({ params }: UpdateSandboxPageProps): Promise<Metadata> {
  const { name } = await params

  return {
    title: `Edit Sandbox: ${name}`,
  }
}

export default async function UpdateSandboxPage({ params }: UpdateSandboxPageProps) {
  const { name } = await params

  return (
    <Suspense fallback={<UpdateSandboxSkeleton />}>
      <UpdateSandboxContent name={name} />
    </Suspense>
  )
}

async function UpdateSandboxContent({ name }: { name: string }) {
  const sandboxResult = listSandboxesCachedQuery({ limit: 200 })
  const mcpResult = listMcpConnectionsCachedQuery({ limit: 200 })
  const skillsResult = listImmutableSkillsCachedQuery()
  const providersResult = listInferenceProvidersCachedQuery()
  const secretHostSuggestions = listSandboxSecretHostSuggestions(name)
  const [sandboxes, mcpConnections, skills, providers] = await Promise.all([
    sandboxResult,
    mcpResult,
    skillsResult,
    providersResult,
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
        initialName={sandbox.name}
        initialPackages={sandbox.packages ?? []}
        initialAllowedHosts={sandbox.allowed_hosts ?? []}
        initialMcpConnectionRefs={mcpConnectionRefs}
        initialSkills={sandbox.skills}
        initialInference={sandbox.inference}
        immutableSkills={skills.skills ?? []}
        inferenceProviders={providers.providers ?? []}
        mcpConnections={mcpConnections.mcpConnections ?? []}
        secretHostSuggestions={secretHostSuggestions}
      />
    </main>
  )
}

async function listSandboxSecretHostSuggestions(sandboxName: string): Promise<SecretHost[]> {
  try {
    const agentsResult = await listAgentsCachedQuery({ limit: 200 })
    if (agentsResult.error) {
      return []
    }

    const agentNames = agentsResult.agents
      .filter((agent) => agent.sandboxName === sandboxName)
      .map((agent) => agent.name)
    if (agentNames.length === 0) {
      return []
    }

    const secrets = await Promise.all(
      agentNames.map((agentName) => listSecretsCachedQuery(agentName, { limit: 200 }))
    )

    return Array.from(
      new Set(
        secrets.flatMap((result) => {
          if (result.error) {
            return []
          }
          return result.items.flatMap((secret) =>
            secret.hosts.flatMap((host) => {
              const parsed = sandboxAllowedHostSchema.safeParse(host)
              return parsed.success ? [parsed.data] : []
            })
          )
        })
      )
    ).sort()
  } catch {
    return []
  }
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
