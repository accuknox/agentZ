import Chat from "@/components/blocks/chat/chat"

export default async function ChatPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params

  return <Chat agentName={name} />
}
