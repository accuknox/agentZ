import type { Metadata } from "next"
import { Suspense } from "react"
import { ChatShell } from "@/components/blocks/chat/chat-shell"

export async function generateMetadata({
  params,
}: PageProps<"/agents/[name]/[sessionId]">): Promise<Metadata> {
  const { name, sessionId } = await params

  return {
    title: `Session ${sessionId}: ${name}`,
  }
}

export default async function ChatPage({ params }: PageProps<"/agents/[name]/[sessionId]">) {
  return (
    <Suspense fallback={null}>
      <ChatPageContent params={params} />
    </Suspense>
  )
}

async function ChatPageContent({
  params,
}: Pick<PageProps<"/agents/[name]/[sessionId]">, "params">) {
  const { name, sessionId } = await params

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell agentName={name} sessionId={sessionId} />
    </main>
  )
}
