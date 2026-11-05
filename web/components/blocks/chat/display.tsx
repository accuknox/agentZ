"use client"

import { createContext, type ReactNode } from "react"
import type { Workspace } from "@/lib/gateway/client"
import type { UserPreferences } from "@/data/user-preferences"

// Keep workspace policy independent of the lazily loaded transcript renderer.
export const ChatActivityContext = createContext(true)

// A scalar context keeps typing and modifier changes out of workspace policy.
export const ChatFollowUpContext = createContext<UserPreferences["followUpBehavior"]>("steer")

export function ChatActivityProvider({
  workspaceType,
  showReasoningAndTools,
  followUpBehavior,
  children,
}: Pick<UserPreferences, "showReasoningAndTools" | "followUpBehavior"> & {
  workspaceType: Workspace["type"]
  children: ReactNode
}) {
  return (
    <ChatActivityContext value={workspaceType === "coding" || showReasoningAndTools}>
      <ChatFollowUpContext value={followUpBehavior}>{children}</ChatFollowUpContext>
    </ChatActivityContext>
  )
}
