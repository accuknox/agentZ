"use client"

import { createContext, type ReactNode } from "react"
import type { Workspace } from "@/lib/gateway/client"
import type { UserPreferences } from "@/data/user-preferences"

// Keep workspace policy independent of the lazily loaded transcript renderer.
export const ChatActivityContext = createContext(true)

export function ChatActivityProvider({
  workspaceType,
  showReasoningAndTools,
  children,
}: Pick<UserPreferences, "showReasoningAndTools"> & {
  workspaceType: Workspace["type"]
  children: ReactNode
}) {
  return (
    <ChatActivityContext value={workspaceType === "coding" || showReasoningAndTools}>
      {children}
    </ChatActivityContext>
  )
}
