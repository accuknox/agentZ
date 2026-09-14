"use client"

import dynamic from "next/dynamic"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { FolderCode, GitBranch, TerminalSquare } from "lucide-react"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import { Workspace } from "@/components/blocks/chat/workspace"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type CodingThread } from "@/lib/gateway/client"
import { runWorkspaceGit } from "@/lib/coding/review"

const GitChanges = dynamic(() => import("./git").then((module) => module.GitChanges), {
  ssr: false,
  loading: () => <Skeleton className="m-3 h-16" />,
})

const CodingTerminal = dynamic(() => import("./terminal").then((module) => module.CodingTerminal), {
  ssr: false,
  loading: () => (
    <div role="status" className="text-muted-foreground flex items-center gap-2 p-3 text-xs">
      <Spinner /> Opening terminal...
    </div>
  ),
})

export function CodingWorkspace({
  thread,
  workspaceId,
  onPreviewerOpenChange,
}: {
  thread: CodingThread
  workspaceId: string
  onPreviewerOpenChange: (open: boolean) => void
}) {
  const { data: actor } = authClient.useSession()
  const tree = thread.worktree
  const status = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
      queryFn: () => runWorkspaceGit(workspaceId, tree.id, { operation: "status" }),
      enabled: !!actor?.user.id,
      refetchInterval: 30_000,
    })
  )
  const data = status.data

  return (
    <Workspace
      agentName={tree.agent_name}
      sessionId={thread.session_id}
      workspaceId={workspaceId}
      onPreviewerOpenChange={onPreviewerOpenChange}
      initialTool="changes"
      tools={[
        {
          id: "changes",
          label: "Changes",
          icon: GitBranch,
          count: data?.files.length,
          render: ({ visible, expanded, onExpand }) => (
            <GitChanges
              thread={thread}
              workspaceId={workspaceId}
              status={status}
              visible={visible}
              expanded={expanded}
              onExpand={onExpand}
            />
          ),
        },
        {
          id: "terminal",
          label: "Terminal",
          icon: TerminalSquare,
          render: ({ visible, onClose }) => (
            <CodingTerminal
              key={`${workspaceId}:${tree.agent_name}:${thread.session_id}:${tree.directory}`}
              agentName={tree.agent_name}
              sessionId={thread.session_id}
              directory={tree.directory}
              workspaceId={workspaceId}
              visible={visible}
              onLastTerminalClosed={onClose}
            />
          ),
        },
      ]}
      footer={
        <footer className="bg-muted/20 text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-t px-2 text-[11px]">
          {data ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className="flex min-w-0 flex-1 items-center gap-2"
                title="Branch selection is fixed for this conversation"
              >
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate">{data.branch || "Detached HEAD"}</span>
              </span>
              <button
                className="text-muted-foreground hover:text-foreground font-mono text-xs"
                aria-label="Copy commit hash"
                title="Copy commit hash"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(data.head)
                    .then(() => toast.success("Commit hash copied"))
                    .catch(() => toast.error("Could not copy commit hash"))
                }
              >
                {data.head.slice(0, 7)}
              </button>
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate" title={tree.branch}>
              {tree.branch}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Copy worktree path"
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(tree.directory)
                    .then(() => toast.success("Worktree path copied"))
                    .catch(() => toast.error("Could not copy path"))
                }
              >
                <FolderCode />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy worktree path</TooltipContent>
          </Tooltip>
        </footer>
      }
    />
  )
}
