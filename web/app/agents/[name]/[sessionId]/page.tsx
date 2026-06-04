import { Suspense } from "react"
import Chat from "@/components/blocks/chat/chat"

type ChatPageParams = {
  name: string
  sessionId: string
}

export default function ChatPage({ params }: { params: Promise<ChatPageParams> }) {
  return (
    <Suspense fallback={null}>
      <ChatPageContent params={params} />
    </Suspense>
  )
}

async function ChatPageContent({ params }: { params: Promise<ChatPageParams> }) {
  const { name, sessionId } = await params

  return <Chat agentName={name} sessionId={sessionId} />
}
