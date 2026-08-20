"use client"

import dynamic from "next/dynamic"
import type { ChatSessionPreference } from "@/lib/gateway/client"
import { PanelRightClose, PanelRightOpen } from "lucide-react"
import type { Route } from "next"
import { useRouter } from "@bprogress/next/app"
import { useState } from "react"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarTrigger } from "@/components/ui/sidebar"

type ChatShellProps = {
  agentName: string
  agentNames?: string[]
  chatPreferences?: ChatSessionPreference
  draftKey?: string
  firstName?: string
  greetingIndex?: number
  sessionId?: string
  title: string
  workspaceId: string
  workspacePath: string
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
  agentNames = [agentName],
  chatPreferences,
  draftKey,
  firstName,
  greetingIndex,
  sessionId,
  title,
  workspaceId,
  workspacePath,
}: ChatShellProps): React.JSX.Element {
  const [previewerOpen, setPreviewerOpen] = useState(false)
  const [promotedSession, setPromotedSession] = useState<{
    chatKey: string
    sessionId: string
  }>()
  const router = useRouter()
  // Soft navigations preserve client trees in this app, so the chat subtree
  // must remount when the logical session target changes. Promoting a new chat
  // keeps its key because the live stream belongs to the session just created.
  const routeChatKey = `${agentName}:${sessionId ?? `new:${draftKey ?? "default"}`}`
  const activePromotion =
    promotedSession &&
    (sessionId === promotedSession.sessionId ||
      (sessionId === undefined && routeChatKey === promotedSession.chatKey))
      ? promotedSession
      : undefined
  const chatKey = activePromotion?.chatKey ?? routeChatKey
  const activeSessionId = sessionId ?? activePromotion?.sessionId

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
      <SessionFileControl agentName={agentName} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-(--workspace-topbar-height) min-w-0 shrink-0 items-center gap-1.5 pr-12 pl-3">
          <SidebarTrigger className="shrink-0" />
          <span className="text-muted-foreground max-w-1/3 truncate text-sm font-medium">
            {agentName}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/70 px-1 text-sm">
            /
          </span>
          <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        </header>
        <div className="@container/chat relative min-w-0 flex-1">
          <Chat
            key={chatKey}
            agentName={agentName}
            agentNames={agentNames}
            chatPreferences={chatPreferences}
            firstName={firstName}
            greetingIndex={greetingIndex}
            onSessionCreated={(id) => {
              setPromotedSession({ chatKey: routeChatKey, sessionId: id })
            }}
            promptMobile={previewerOpen}
            sessionId={activeSessionId}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onAgentChange={(name) => {
              const url = new URL(window.location.href)
              url.searchParams.set("agent", name)
              router.replace(`${url.pathname}${url.search}` as Route)
            }}
          />
        </div>
      </div>
      <FilesWorkspace
        agentName={agentName}
        onPreviewerOpenChange={setPreviewerOpen}
        sessionId={sessionId}
        workspaceId={workspaceId}
      />
    </div>
  )
}

function SessionFileControl({ agentName }: { agentName: string }) {
  const { dirtyAgent, openAgent, toggleAgent } = useFileWorkspace()
  const filesOpen = openAgent === agentName
  const filesDirty = dirtyAgent === agentName
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={filesOpen ? "Close files" : "Open files"}
            aria-pressed={filesOpen}
            className="absolute top-3 right-3 z-50 hidden lg:inline-flex"
            onClick={() => {
              if (filesOpen && filesDirty) {
                setConfirmingDiscard(true)
                return
              }
              toggleAgent(agentName)
            }}
            size="icon-sm"
            variant={filesOpen ? "secondary" : "ghost"}
          >
            {filesOpen ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{filesOpen ? "Close files" : "Open files"}</TooltipContent>
      </Tooltip>
      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close files?</DialogTitle>
            <DialogDescription>Your unsaved file changes will be discarded.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmingDiscard(false)} variant="outline">
              Cancel
            </Button>
            <Button
              data-dialog-submit
              onClick={() => {
                toggleAgent(agentName)
                setConfirmingDiscard(false)
              }}
              variant="destructive"
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
