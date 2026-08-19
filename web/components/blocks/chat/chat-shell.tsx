"use client"

import dynamic from "next/dynamic"
import { FolderTree } from "lucide-react"
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

type ChatShellProps = {
  agentName: string
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
  draftKey,
  firstName,
  greetingIndex,
  sessionId,
  title,
  workspaceId,
  workspacePath,
}: ChatShellProps): React.JSX.Element {
  const [previewerOpen, setPreviewerOpen] = useState(false)
  // Soft navigations preserve client trees in this app, so the chat subtree
  // must remount when the logical session target changes.
  const chatKey = `${agentName}:${sessionId ?? `new:${draftKey ?? "default"}`}`

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        <SessionFileControl agentName={agentName} />
      </header>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="@container/chat relative min-w-0 flex-1">
          <Chat
            key={chatKey}
            agentName={agentName}
            firstName={firstName}
            greetingIndex={greetingIndex}
            promptMobile={previewerOpen}
            sessionId={sessionId}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
          />
        </div>
        <FilesWorkspace
          agentName={agentName}
          onPreviewerOpenChange={setPreviewerOpen}
          sessionId={sessionId}
          workspaceId={workspaceId}
        />
      </div>
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
            className="hidden shrink-0 lg:inline-flex"
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
            <FolderTree aria-hidden="true" />
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
