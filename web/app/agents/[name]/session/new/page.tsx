import type { Metadata } from "next"
import { Suspense } from "react"
import Chat from "@/components/blocks/chat/chat"

type ChatPageParams = {
  name: string
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

export default function ChatPage({ params }: { params: Promise<ChatPageParams> }) {
  return (
    <Suspense fallback={null}>
      <ChatPageContent params={params} />
    </Suspense>
  )
}

async function ChatPageContent({ params }: { params: Promise<ChatPageParams> }) {
  const { name } = await params

  return <Chat agentName={name} />
}
