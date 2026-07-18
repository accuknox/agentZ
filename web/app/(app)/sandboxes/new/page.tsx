import type { Metadata } from "next"
import { Suspense } from "react"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { defaultSandboxPackages } from "@/data/sandbox-defaults"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { SandboxWizard } from "../wizard"

export const metadata: Metadata = {
  title: "New Sandbox",
}

export default function NewSandboxPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <div className="min-w-0 px-4 pt-4 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-normal">New sandbox</h1>
      </div>
      <Suspense fallback={<WizardSkeleton />}>
        <NewSandboxWizard />
      </Suspense>
    </main>
  )
}

async function NewSandboxWizard() {
  const [result, skills, providers] = await Promise.all([
    listMcpConnectionsCachedQuery({ limit: 200 }),
    listImmutableSkillsCachedQuery(),
    listInferenceProvidersCachedQuery(),
  ])
  return (
    <SandboxWizard
      mode="create"
      initialPackages={[...defaultSandboxPackages]}
      immutableSkills={skills.skills ?? []}
      inferenceProviders={providers.providers ?? []}
      mcpConnections={result.mcpConnections ?? []}
    />
  )
}

function WizardSkeleton() {
  return <div className="bg-muted/20 h-96" />
}
