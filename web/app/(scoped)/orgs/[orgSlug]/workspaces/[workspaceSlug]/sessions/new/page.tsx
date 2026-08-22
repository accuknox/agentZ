import { randomInt } from "node:crypto"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { getAuth } from "@/lib/auth"
import { getChatSessionPreference } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export const metadata: Metadata = {
  title: { absolute: "New chat | AgentZ" },
}

export default async function NewChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ agent?: string }>
}) {
  const [{ orgSlug, workspaceSlug }, query, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") notFound()

  const [agentsResult, preference, authSession] = await Promise.all([
    listAllAgentsCachedQuery(scope.workspace.id),
    getChatSessionPreference({ client: getGatewayServerClient(scope.workspace.id) }),
    getAuth().api.getSession({ headers: requestHeaders }),
  ])
  if (agentsResult.error || preference.error) {
    throw new Error("Failed to prepare a new chat")
  }
  const agents = agentsResult.agents.filter((agent) => agent.capabilities.use)
  const selected =
    agents.find((agent) => agent.name === query.agent) ??
    agents.find((agent) => agent.name === preference.data.last_agent_name) ??
    agents[0]
  if (!selected) {
    return (
      <main className="grid h-full flex-1 place-items-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold">No agent is ready for chat</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Create an agent or ask a workspace administrator for access.
          </p>
        </div>
      </main>
    )
  }
  const firstName =
    authSession?.user.name?.trim().split(/\s+/, 1)[0] ||
    authSession?.user.email.split("@")[0]?.trim() ||
    undefined
  const workspacePath =
    `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}` as const

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell
        agentName={selected.name}
        agentNames={agents.map((agent) => agent.name)}
        chatPreferences={preference.data}
        firstName={firstName}
        greetingIndex={randomInt(10)}
        title="New chat"
        workspaceId={scope.workspace.id}
        workspacePath={workspacePath}
      />
    </main>
  )
}
