import { RequestError } from "@/components/request-error"
import { RememberRoute, missingRoute } from "@/data/route-memory"
import { Suspense } from "react"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { getWorkspaceScope } from "@/data/workspaces"
import { listAgentTools } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { AgentTools } from "@/app/agent/agent-tools"

/** metadata names the tool management view in the browser. */
export const metadata = { title: "Tools" }

/** AgentToolsPage renders the agent layout while the live definitions load. */
export default function AgentToolsPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents/[agentName]/tools">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <AgentToolsContent {...props} />
    </Suspense>
  )
}

async function AgentToolsContent({
  params,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/agents/[agentName]/tools">) {
  const { orgSlug, workspaceSlug, agentName } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind === "error")
    return <RequestError title="Could not load this workspace" error={scope.error} />
  if (scope.kind !== "ready") return missingRoute()

  const result = await listAgentTools({
    client: getGatewayServerClient(scope.workspace.id),
    path: { agentName },
  })
  if (result.error) {
    return (
      <AdministrationState
        kind={result.error.code === "forbidden" ? "forbidden" : "failed"}
        title="Tools could not be loaded"
        description={result.error.message}
      />
    )
  }
  return (
    <>
      <RememberRoute />
      <AgentTools agentName={agentName} workspaceId={scope.workspace.id} initial={result.data} />
    </>
  )
}
