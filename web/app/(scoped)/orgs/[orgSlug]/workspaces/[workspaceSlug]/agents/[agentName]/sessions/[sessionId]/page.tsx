import { RememberRoute, missingRoute } from "@/data/route-memory"
import { getCodingThread, listAgents, type Workspace } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import type { Metadata } from "next"
import { cache, Suspense } from "react"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { getWorkspaceScope } from "@/data/workspaces"
import { createAgentOpencodeClient } from "@/lib/opencode/server-client"
import { AgentUnavailable, RequestError } from "@/components/request-error"

type ChatPageParams = Promise<{
  agentName: string
  orgSlug: string
  sessionId: string
  workspaceSlug: string
}>

type ChatPageProps = {
  params: ChatPageParams
}

// Metadata shares the lookup, but runtime failures remain renderable page data.
const loadChat = cache(
  async (workspaceId: string, type: Workspace["type"], agentName: string, sessionId: string) => {
    const agents = await listAgents({
      client: getGatewayServerClient(workspaceId),
      query: { agent_name: [agentName], limit: 1 },
    })
    if (agents.error) return { error: agents.error }
    const agent = agents.data.agents.find((item) => item.name === agentName)
    if (!agent) return missingRoute()
    if (agent.status === "DEGRADED" || agent.status === "PROGRESSING") {
      return { agent, error: { code: "agent_unavailable", message: "" } }
    }
    const coding =
      type === "coding"
        ? await getCodingThread({
            client: getGatewayServerClient(workspaceId),
            path: { agentName, sessionId },
          })
        : undefined
    if (coding?.response?.status === 404) return missingRoute()
    if (coding?.error) return { error: coding.error }
    const client = await createAgentOpencodeClient(agentName, { workspaceId })
    // The OpenCode SDK rejects on transport errors, unlike the gateway SDK.
    const session = await client.session.get({ path: { id: sessionId } }).catch(() => undefined)
    if (session?.response.status === 404 && session.error?.name === "NotFoundError") {
      return missingRoute()
    }
    if (session?.response.status === 403) {
      return {
        error: { code: "forbidden", message: "You no longer have access to this conversation." },
      }
    }
    if (!session?.data) {
      return {
        agent,
        error: { code: "agent_unavailable", message: "The agent could not be reached." },
      }
    }
    return { coding: coding?.data, title: session.data.title?.trim() || sessionId }
  }
)

export async function generateMetadata({ params }: ChatPageProps): Promise<Metadata> {
  const { agentName, orgSlug, sessionId, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  const chat =
    scope.kind === "ready"
      ? await loadChat(scope.workspace.id, scope.workspace.type, agentName, sessionId)
      : undefined
  return { title: { absolute: `${agentName} - ${chat?.title ?? sessionId} | AgentZ` } }
}

export default function ChatPage({ params }: ChatPageProps) {
  return (
    <Suspense fallback={null}>
      <ChatPageContent params={params} />
    </Suspense>
  )
}

async function ChatPageContent({ params }: ChatPageProps) {
  const { agentName, orgSlug, sessionId, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind === "error")
    return <RequestError title="Could not load this workspace" error={scope.error} />
  if (scope.kind !== "ready") {
    return missingRoute()
  }
  const chat = await loadChat(scope.workspace.id, scope.workspace.type, agentName, sessionId)
  if (chat.error) {
    return chat.agent ? (
      <AgentUnavailable agent={chat.agent} error={chat.error} />
    ) : (
      <RequestError title="Could not load this conversation" error={chat.error} />
    )
  }
  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <RememberRoute />
      <ChatShell
        codingThread={chat.coding}
        agentName={agentName}
        sessionId={sessionId}
        title={chat.title}
        workspaceId={scope.workspace.id}
        workspacePath={`/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`}
      />
    </main>
  )
}
