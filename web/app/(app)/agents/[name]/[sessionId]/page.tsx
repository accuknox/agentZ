import type { Metadata } from "next"
import { Suspense } from "react"
import { ChatShell } from "@/components/blocks/chat/chat-shell"

type ChatPageParams = Promise<{
  name: string
  sessionId: string
}>

type ChatPageProps = {
  params: ChatPageParams
}

export async function generateMetadata({ params }: ChatPageProps): Promise<Metadata> {
  const { name, sessionId } = await params

  return {
    title: `Session ${sessionId}: ${name}`,
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
  const { name, sessionId } = await params

  return (
    <main
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0"
      data-chat-page
    >
      <ChatShell agentName={name} sessionId={sessionId} />
    </main>
  )
}
