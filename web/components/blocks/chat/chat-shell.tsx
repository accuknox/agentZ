"use client"

import dynamic from "next/dynamic"
import type { ChatProps } from "./chat"
import type { ChatSessionPreference, CodingThread } from "@/lib/gateway/client"
import type { Route } from "next"
import { useRouter } from "@bprogress/next/app"
import { useState, type ReactNode } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { queryOptions, skipToken, useQuery } from "@tanstack/react-query"
import { sessionInfoQueryOptions } from "./use-opencode-chat"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { GitBranchIcon } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { runWorkspaceGit } from "@/lib/coding/review"

type ChatShellProps = Pick<
  ChatProps,
  | "createSession"
  | "composerContext"
  | "initialMessage"
  | "onDraftChange"
  | "draftModel"
  | "onDraftModelChange"
  | "draftMode"
  | "onDraftModeChange"
> & {
  draftId?: string
  onDraftPromoted?: () => void
  onDraftAgentChange?: (name: string) => void
  draftPath?: string
  headerContext?: ReactNode
  headerActions?: ReactNode
  agentName: string
  agentNames?: string[]
  codingThread?: CodingThread
  chatPreferences?: ChatSessionPreference
  projectName?: string
  firstName?: string
  greetingIndex?: number
  sessionId?: string
  title: string
  workspaceId: string
  workspacePath: string
}

const GitActions = dynamic(
  () => import("@/components/blocks/coding/git-actions").then((module) => module.GitActions),
  { ssr: false }
)

const CodingWorkspace = dynamic(
  () => import("@/components/blocks/coding/workspace").then((module) => module.CodingWorkspace),
  { ssr: false }
)

const Chat = dynamic(() => import("@/components/blocks/chat/chat"), {
  ssr: false,
})
const Workspace = dynamic(
  () => import("@/components/blocks/chat/workspace").then((module) => module.Workspace),
  { ssr: false }
)

export function ChatShell({
  createSession,
  initialMessage,
  draftModel,
  onDraftModelChange,
  draftMode,
  onDraftModeChange,
  onDraftChange,
  onDraftPromoted,
  onDraftAgentChange,
  composerContext,
  draftPath: initialDraftPath,
  draftId,
  headerContext,
  headerActions,
  agentName,
  agentNames = [agentName],
  chatPreferences,
  codingThread,
  projectName,
  firstName,
  greetingIndex,
  sessionId,
  title,
  workspaceId,
  workspacePath,
}: ChatShellProps): React.JSX.Element {
  const [previewerOpen, setPreviewerOpen] = useState(false)
  const { data: actor } = authClient.useSession()
  // GitActions owns status fetching and refreshes after Git events.
  const gitStatus = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, codingThread?.worktree.id, actor?.user.id],
      queryFn: codingThread
        ? () => runWorkspaceGit(workspaceId, codingThread.worktree.id, { operation: "status" })
        : skipToken,
      enabled: false,
    })
  )
  const branch = gitStatus.data?.branch ?? codingThread?.worktree.branch
  const [promotedSession, setPromotedSession] = useState<{
    chatKey: string
    sessionId: string
  }>()
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const draftKey = search.get("draft")
  const activeDraftId = draftId ?? draftKey ?? undefined
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
        <header className="@container/header-actions flex h-(--workspace-topbar-height) min-w-0 shrink-0 items-center gap-1.5 px-3">
          <SidebarTrigger className="shrink-0" />
          <div className="text-muted-foreground max-w-1/3 min-w-0 truncate text-sm font-medium">
            {headerContext ?? agentName}
          </div>
          <span aria-hidden="true" className="text-muted-foreground/70 text-sm">
            /
          </span>
          <h1 className="min-w-0 truncate text-sm font-semibold">{sessionTitle.data ?? title}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {headerActions}
            {codingThread ? (
              <GitActions
                key={codingThread.worktree.id}
                thread={codingThread}
                workspaceId={workspaceId}
              />
            ) : null}
          </div>
        </header>
        <div className="@container/chat relative min-h-0 min-w-0 flex-1">
          <Chat
            key={chatKey}
            coding={codingThread !== undefined || createSession !== undefined}
            draftMode={draftMode}
            onDraftModeChange={activeSessionId ? undefined : onDraftModeChange}
            createSession={createSession}
            initialMessage={initialMessage}
            draftModel={draftModel}
            onDraftModelChange={onDraftModelChange}
            onDraftChange={activeSessionId ? undefined : onDraftChange}
            composerContext={
              codingThread
                ? () => (
                    <span
                      className="text-muted-foreground flex h-7 max-w-60 min-w-0 items-center gap-1.5 text-xs"
                      title={`${branch || "Detached HEAD"}\n${codingThread.worktree.directory}`}
                    >
                      <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {branch || codingThread.worktree.directory.split("/").at(-1)}
                      </span>
                    </span>
                  )
                : composerContext
            }
            revertDisabled={codingThread?.worktree.shared}
            agentName={agentName}
            agentNames={agentNames}
            chatPreferences={chatPreferences}
            projectName={projectName}
            firstName={firstName}
            greetingIndex={greetingIndex}
            onSessionCreated={(id) => {
              setPromotedSession({ chatKey: routeChatKey, sessionId: id })
              onDraftPromoted?.()

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
            navigationPending={
              activePromotion !== undefined && routeSessionId !== activePromotion.sessionId
            }
            sessionId={activeSessionId}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            onAgentChange={(name) => {
              if (onDraftAgentChange) {
                onDraftAgentChange(name)
                return
              }
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
      {!codingThread && !createSession ? (
        <Workspace
          key={`${workspaceId}:${agentName}`}
          agentName={agentName}
          onPreviewerOpenChange={setPreviewerOpen}
          sessionId={activeSessionId}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>
  )
}
