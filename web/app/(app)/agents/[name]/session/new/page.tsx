import type { Metadata } from "next"
import { ChatShell } from "@/components/blocks/chat/chat-shell"

type ChatPageParams = {
  name: string
}

type ChatPageSearchParams = {
  draft?: string
}

export async function generateMetadata({
  params,
}: {
  params: Promise<ChatPageParams>
}): Promise<Metadata> {
  const { name } = await params

  return {
    title: `New Session: ${name}`,
  }
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<ChatPageParams>
  searchParams: Promise<ChatPageSearchParams>
}) {
  const { name } = await params
  const { draft } = await searchParams

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell agentName={name} draftKey={draft} />
    </main>
  )
}
