"use client"

import dynamic from "next/dynamic"

type ChatShellProps = {
  agentName: string
  sessionId?: string
}

const Chat = dynamic(() => import("@/components/blocks/chat/chat"), {
  ssr: false,
})

export function ChatShell({ agentName, sessionId }: ChatShellProps) {
  return <Chat agentName={agentName} sessionId={sessionId} />
}
