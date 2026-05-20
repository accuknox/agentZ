import Chat from "@/components/blocks/chat/chat"

export default async function ChatPage({
  params,
}: {
  params: Promise<{ name: string; sessionId: string }>
}) {
  const { name, sessionId } = await params

  return <Chat agentName={name} sessionId={sessionId} />
}
