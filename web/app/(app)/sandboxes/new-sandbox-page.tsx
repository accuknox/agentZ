import type { UrlObject } from "node:url"
import { Suspense } from "react"
import { listGuardrailPoliciesQuery, getGuardrailSettingsQuery } from "@/data/guardrail.queries"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { listMcpConnectionsCachedQuery } from "@/data/mcp.queries"
import { defaultSandboxPackages } from "@/data/sandbox-defaults"
import { listSkills } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { listInferencePoolsCachedQuery } from "@/data/inference-pool.queries"
import { SandboxWizard } from "./wizard"

type NewSandboxPageProps = {
  basePath: string
  providersHref: UrlObject
  workspaceId?: string
}

export default function NewSandboxPage(props: NewSandboxPageProps) {
  const { basePath, providersHref, workspaceId } = props

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 pb-4 sm:pb-6">
      <AdministrationPageHeader title="New sandbox" />
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

async function NewSandboxWizard(props: NewSandboxPageProps) {
  const { basePath, providersHref, workspaceId } = props

  const [result, skills, providers, pools, policies, guardrailSettings] = await Promise.all([
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
    listGuardrailPoliciesQuery(workspaceId),
    getGuardrailSettingsQuery(workspaceId),
  ])
  if (policies.error || guardrailSettings.error)
    return (
      <AdministrationState
        description={
          policies.error?.message ??
          guardrailSettings.error?.message ??
          "Guardrail configuration is unavailable."
        }
        kind="failed"
        title="Could not load protection settings"
      />
    )
  return (
    <SandboxWizard
      mode="create"
      guardrailPolicies={policies.data.items}
      guardrailSettings={guardrailSettings.data}
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
  return <div className="h-96 bg-muted/20" />
}
