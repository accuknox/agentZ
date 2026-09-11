import { getCodingThread } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import type { Metadata } from "next"
import Link from "next/link"
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
  const client = await createAgentOpencodeClient(agentName, { workspaceId: scope.workspace.id })
  const session = await client.session.get({ path: { id: sessionId } })
  const title = session.data?.title?.trim() || sessionId
  const coding =
    scope.workspace.type === "coding"
      ? await getCodingThread({
          client: getGatewayServerClient(scope.workspace.id),
          path: { agentName, sessionId },
        })
      : undefined

  if (coding?.error && coding.response?.status !== 404) {
    throw new Error("Could not load thread", { cause: coding.error })
  }

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell
        codingThread={coding?.data}
        headerContext={
          coding?.data ? (
            <Link
              href={`/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/projects?${new URLSearchParams({ project: coding.data.worktree.project_id, agent: agentName })}`}
              className="hover:text-foreground transition-colors"
              title={coding.data.repository}
            >
              {coding.data.repository}
            </Link>
          ) : undefined
        }
        agentName={agentName}
        sessionId={sessionId}
        title={title}
        workspaceId={scope.workspace.id}
        workspacePath={`/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`}
      />
    </main>
  )
}
