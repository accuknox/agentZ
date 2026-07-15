"use client"

import dynamic from "next/dynamic"
import { useState } from "react"

type ChatShellProps = {
  agentName: string
  draftKey?: string
  firstName?: string
  greetingIndex?: number
  sessionId?: string
}

const Chat = dynamic(() => import("@/components/blocks/chat/chat"), {
  ssr: false,
})
const FilesWorkspace = dynamic(
  () => import("@/components/blocks/chat/files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false }
)

export function ChatShell({
  agentName,
  draftKey,
  firstName,
  greetingIndex,
  sessionId,
}: ChatShellProps): React.JSX.Element {
  const [previewerOpen, setPreviewerOpen] = useState(false)
  // Soft navigations preserve client trees in this app, so the chat subtree
  // must remount when the logical session target changes.
  const chatKey = `${agentName}:${sessionId ?? `new:${draftKey ?? "default"}`}`

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className="@container/chat relative min-w-0 flex-1">
        <Chat
          key={chatKey}
          agentName={agentName}
          firstName={firstName}
          greetingIndex={greetingIndex}
          promptMobile={previewerOpen}
          sessionId={sessionId}
        />
      </div>
      <FilesWorkspace
        agentName={agentName}
        onPreviewerOpenChange={setPreviewerOpen}
        sessionId={sessionId}
      />
    </div>
  )
}
