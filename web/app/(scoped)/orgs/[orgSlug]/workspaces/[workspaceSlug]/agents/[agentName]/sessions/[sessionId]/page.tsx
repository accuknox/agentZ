import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"
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

export async function generateMetadata({ params }: ChatPageProps): Promise<Metadata> {
  const { agentName, orgSlug, sessionId, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  let sessionTitle = sessionId

  if (scope.kind === "ready") {
    const client = await createAgentOpencodeClient(agentName, {
      workspaceId: scope.workspace.id,
    })
    const result = await client.session.get({ path: { id: sessionId } })
    sessionTitle = result.data?.title?.trim() || sessionId
  }

  return {
    title: {
      absolute: `${agentName} - ${sessionTitle} | AgentZ`,
    },
  }
}

export default async function ChatPage({ params }: ChatPageProps) {
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
    notFound()
  }

  return (
    <main
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0"
      data-chat-page
    >
      <h1 className="sr-only">
        Session {sessionId} with {agentName}
      </h1>
      <ChatShell
        agentName={agentName}
        sessionId={sessionId}
        workspaceId={scope.workspace.id}
        workspacePath={`/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`}
      />
    </main>
  )
}
