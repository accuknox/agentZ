"use client"

import dynamic from "next/dynamic"
import type { ChatProps } from "./chat"
import type { ChatSessionPreference, CodingThread } from "@/lib/gateway/client"
import { PanelRightClose, PanelRightOpen } from "lucide-react"
import type { Route } from "next"
import { useRouter } from "@bprogress/next/app"
import { useState, type ReactNode } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { sessionInfoQueryOptions } from "./use-opencode-chat"
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
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"

type ChatShellProps = Pick<ChatProps, "createSession" | "composerContext" | "draftId"> & {
  draftPath?: string
  headerContext?: ReactNode
  headerActions?: ReactNode
  agentName: string
  agentNames?: string[]
  codingThread?: CodingThread
  chatPreferences?: ChatSessionPreference
  firstName?: string
  greetingIndex?: number
  sessionId?: string
  title: string
  workspaceId: string
  workspacePath: string
}

const CodingWorkspace = dynamic(
  () => import("@/components/blocks/coding/workspace").then((module) => module.CodingWorkspace),
  { ssr: false }
)

const Chat = dynamic(() => import("@/components/blocks/chat/chat"), {
  ssr: false,
})
const FilesWorkspace = dynamic(
  () => import("@/components/blocks/chat/files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false }
)

export function ChatShell({
  createSession,
  composerContext,
  draftPath: initialDraftPath,
  draftId,
  headerContext,
  headerActions,
  agentName,
  agentNames = [agentName],
  chatPreferences,
  codingThread,
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
  const pathname = usePathname()
  const search = useSearchParams()
  const draftKey = search.get("draft")
  const activeDraftId = draftId ? `${draftId}:${draftKey ?? "default"}` : (draftKey ?? undefined)
  const draftPath = initialDraftPath ?? `${workspacePath}/sessions/new`
  const routeSessionId = pathname === draftPath ? undefined : sessionId
  // Soft navigations preserve client trees in this app, so the chat subtree
  // must remount when the logical session target changes. Promoting a new chat
  // keeps its key because the live stream belongs to the session just created.
  const routeChatKey = `${agentName}:${routeSessionId ?? `new:${activeDraftId ?? "default"}`}`
  const promotedSessionPath = promotedSession
    ? `${workspacePath}/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(promotedSession.sessionId)}`
    : undefined
  const activePromotion =
    promotedSession &&
    (pathname === promotedSessionPath ||
      routeSessionId === promotedSession.sessionId ||
      (routeSessionId === undefined && routeChatKey === promotedSession.chatKey))
      ? promotedSession
      : undefined
  const chatKey = activePromotion?.chatKey ?? routeChatKey
  const activeSessionId = routeSessionId ?? activePromotion?.sessionId
  const sessionTitle = useQuery({
    ...sessionInfoQueryOptions(agentName, workspaceId, activeSessionId ?? ""),
    enabled: false,
    select: (session) => session.title,
  })

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-(--workspace-topbar-height) min-w-0 shrink-0 items-center gap-1.5 px-3">
          <SidebarTrigger className="shrink-0" />
          <div className="text-muted-foreground max-w-1/3 truncate text-sm font-medium">
            {headerContext ?? agentName}
          </div>
          <span aria-hidden="true" className="text-muted-foreground/70 px-1 text-sm">
            /
          </span>
          <h1 className="min-w-0 truncate text-sm font-semibold">{sessionTitle.data ?? title}</h1>
          {headerActions}
          {!codingThread ? (
            <div className="ml-auto">
              <SessionFileControl agentName={agentName} />
            </div>
          ) : null}
        </header>
        <div className="@container/chat relative min-h-0 min-w-0 flex-1">
          <Chat
            key={chatKey}
            createSession={createSession}
            composerContext={composerContext}
            revertDisabled={codingThread?.worktree.shared}
            agentName={agentName}
            agentNames={agentNames}
            chatPreferences={chatPreferences}
            draftId={activeDraftId}
            firstName={firstName}
            greetingIndex={greetingIndex}
            onSessionCreated={(id) => {
              setPromotedSession({ chatKey: routeChatKey, sessionId: id })

              const url = new URL(window.location.href)
              if (url.pathname !== draftPath || url.searchParams.toString() !== search.toString()) {
                return
              }

              const sessionPath =
                `${workspacePath}/agents/${encodeURIComponent(agentName)}/sessions/` +
                encodeURIComponent(id)
              window.history.replaceState(null, "", sessionPath)
              router.refresh({ showProgress: false })
            }}
            promptMobile={previewerOpen}
            sessionId={activeSessionId}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onAgentChange={(name) => {
              const url = new URL(window.location.href)
              url.searchParams.set("agent", name)
              router.replace(`${url.pathname}${url.search}` as Route, { showProgress: false })
            }}
          />
        </div>
      </div>
      {codingThread ? (
        <CodingWorkspace
          thread={codingThread}
          workspaceId={workspaceId}
          key={codingThread.id}
          onPreviewerOpenChange={setPreviewerOpen}
        />
      ) : null}
      {!codingThread ? (
        <FilesWorkspace
          agentName={agentName}
          onPreviewerOpenChange={setPreviewerOpen}
          sessionId={activeSessionId}
          workspaceId={workspaceId}
        />
      ) : null}
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
            className={cn("hidden lg:inline-flex", filesOpen && "absolute top-3 right-3 z-50")}
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
