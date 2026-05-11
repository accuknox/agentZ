import Chat from "@/components/blocks/chat/chat"
import { getChatHistoryAction } from "@/data/agent.actions"

const initialHistoryLimit = 25

export default async function ChatPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params
  const initialHistory = await getChatHistoryAction({
    agentName: id,
    limit: initialHistoryLimit,
  })

  return (
    <main className="flex h-[calc(100svh-4rem)] min-h-0 overflow-hidden">
      <Chat id={id} initialHistory={initialHistory} initialHistoryLimit={initialHistoryLimit} />
    </main>
  )
}
