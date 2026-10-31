import { RememberRoute, missingRoute } from "@/data/route-memory"
import { getCodingThread, type Workspace } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import type { Metadata } from "next"
import { cache, Suspense } from "react"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { getWorkspaceScope } from "@/data/workspaces"
import { createAgentOpencodeClient } from "@/lib/opencode/server-client"

type ChatPageParams = Promise<{
  agentName: string
  orgSlug: string
  sessionId: string
  workspaceSlug: string
}>

type ChatPageProps = {
  params: ChatPageParams
}

// Metadata and content share one snapshot and preserve transport failures as errors.
const loadChat = cache(
  async (workspaceId: string, type: Workspace["type"], agentName: string, sessionId: string) => {
    const coding =
      type === "coding"
        ? await getCodingThread({
            client: getGatewayServerClient(workspaceId),
            path: { agentName, sessionId },
          })
        : undefined
    if (coding?.response?.status === 404) return missingRoute()
    if (coding?.error) throw new Error("Could not load chat", { cause: coding.error })
    const client = await createAgentOpencodeClient(agentName, { workspaceId })
    const session = await client.session.get({ path: { id: sessionId } })
    if (session.response.status === 404) return missingRoute()
    if (session.error) throw new Error("Could not load chat", { cause: session.error })
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
  if (scope.kind !== "ready") {
    return missingRoute()
  }
  const { coding, title } = await loadChat(
    scope.workspace.id,
    scope.workspace.type,
    agentName,
    sessionId
  )
  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <RememberRoute />
      <ChatShell
        codingThread={coding}
        agentName={agentName}
        sessionId={sessionId}
        title={title}
        workspaceId={scope.workspace.id}
        workspacePath={`/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`}
      />
    </main>
  )
}
