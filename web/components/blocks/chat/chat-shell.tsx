"use client"

import dynamic from "next/dynamic"

type ChatShellProps = {
  agentName: string
  draftKey?: string
  firstName?: string
  sessionId?: string
}

const Chat = dynamic(() => import("@/components/blocks/chat/chat"), {
  ssr: false,
})

export function ChatShell({ agentName, draftKey, firstName, sessionId }: ChatShellProps) {
  // Soft navigations preserve client trees in this app, so the chat subtree
  // must remount when the logical session target changes.
  const chatKey = `${agentName}:${sessionId ?? `new:${draftKey ?? "default"}`}`

  return <Chat key={chatKey} agentName={agentName} firstName={firstName} sessionId={sessionId} />
}
