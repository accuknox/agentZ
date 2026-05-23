import { Suspense } from "react"
import Chat from "@/components/blocks/chat/chat"

export default function ChatPage({
  params,
}: {
  params: Promise<{ name: string; sessionId: string }>
}) {
  return (
    <Suspense fallback={null}>
      {params.then(({ name, sessionId }) => (
        <Chat agentName={name} sessionId={sessionId} />
      ))}
    </Suspense>
  )
}
