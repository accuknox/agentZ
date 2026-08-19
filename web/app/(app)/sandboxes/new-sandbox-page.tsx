import type { UrlObject } from "node:url"
import { Suspense } from "react"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { defaultSandboxPackages } from "@/data/sandbox-defaults"
import { listSkills } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listInferencePoolsCachedQuery } from "@/data/inference-pool.queries"
import { SandboxWizard } from "./wizard"

export default function NewSandboxPage({
  basePath,
  providersHref,
  workspaceId,
}: {
  basePath: string
  providersHref: UrlObject
  workspaceId?: string
}) {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <div className="min-w-0 px-4 pt-4 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-normal">New sandbox</h1>
      </div>
      <Suspense fallback={<WizardSkeleton />}>
        <NewSandboxWizard
          basePath={basePath}
          providersHref={providersHref}
          workspaceId={workspaceId}
        />
      </Suspense>
    </main>
  )
}

async function NewSandboxWizard({
  basePath,
  providersHref,
  workspaceId,
}: {
  basePath: string
  providersHref: UrlObject
  workspaceId?: string
}) {
  const [result, skills, providers, pools] = await Promise.all([
    listMcpConnectionsCachedQuery(
      { limit: 50, sort_by: "created_at", sort_order: "desc" },
      workspaceId
    ),
    listSkills({
      client: getGatewayServerClient(workspaceId),
      headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
      query: { limit: 50, sort_by: "name", sort_order: "asc" },
    }),
    listInferenceProvidersCachedQuery(workspaceId),
    workspaceId
      ? listInferencePoolsCachedQuery(workspaceId)
      : Promise.resolve({ pools: [], error: undefined }),
  ])
  return (
    <SandboxWizard
      mode="create"
      providersHref={providersHref}
      scope={{ basePath, workspaceId }}
      initialPackages={[...defaultSandboxPackages]}
      immutableSkills={skills.data?.skills ?? []}
      immutableSkillsNextPageToken={skills.data?.next_page_token ?? ""}
      inferenceProviders={providers.providers ?? []}
      inferencePools={pools.pools ?? []}
      mcpConnections={result.mcpConnections ?? []}
      mcpConnectionsNextPageToken={result.nextPageToken ?? ""}
    />
  )
}

function WizardSkeleton() {
  return <div className="bg-muted/20 h-96" />
}
