"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { queryOptions, useIsMutating, useMutation, useQuery } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  FolderCode,
  Files,
  GitBranch,
  Maximize2,
  Minimize2,
  PanelRightClose,
  TerminalSquare,
} from "lucide-react"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { WorkspaceResizeHandle } from "@/components/blocks/chat/files-workspace"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type CodingThread } from "@/lib/gateway/client"
import { runWorkspaceGit } from "@/lib/coding/review"
import { cn } from "@/lib/utils"

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
const FilesWorkspace = dynamic(
  () => import("../chat/files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false }
)
const views = [
  { id: "files", label: "Files", icon: Files },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
] as const

type View = (typeof views)[number]["id"]

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
  const { pendingPreview } = useFileWorkspace()
  const [{ tab, open }, setPanel] = useState<{ tab: View; open: boolean }>({
    tab: "changes",
    open: false,
  })
  const [visited, setVisited] = useState<Set<View>>(new Set())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const tree = thread.worktree
  const mutationKey = ["coding", "git", workspaceId, tree.id]
  const pending = useIsMutating({ mutationKey }) > 0
  const status = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
      queryFn: () => runWorkspaceGit(workspaceId, tree.id, { operation: "status" }),
      refetchInterval: open && tab === "changes" && !pending ? 5000 : false,
    })
  )
  const data = status.data
  const { refetch: refreshStatus } = status

  useEffect(() => {
    if (open && tab === "changes") void refreshStatus()
  }, [open, tab, refreshStatus])

  const [handledPreview, setHandledPreview] = useState<typeof pendingPreview>()
  if (pendingPreview?.agent === tree.agent_name && pendingPreview !== handledPreview) {
    setHandledPreview(pendingPreview)
    setPanel({ tab: "files", open: true })
    setVisited((current) => new Set(current).add("files"))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.code === "KeyB" && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        setVisited((current) => new Set(current).add(tab))
        setPanel((current) => ({ ...current, open: !current.open }))
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [tab])

  const checkout = useMutation({
    mutationKey,
    mutationFn: (ref: string) =>
      runWorkspaceGit(workspaceId, tree.id, {
        operation: "checkout",
        ref,
        expected_head: data?.head,
      }),
    onError: (error) => toast.error(error.message),
    onSettled: () => status.refetch(),
  })

  return (
    <>
      <aside
        aria-label="Coding workspace"
        className={cn(
          "bg-background min-h-0 min-w-0 shrink-0 flex-col border-l",
          open
            ? "absolute inset-y-0 right-12 left-0 z-30 flex lg:relative lg:inset-auto lg:z-auto lg:w-auto lg:max-w-[calc(100%-22rem)]"
            : "hidden",
          expanded &&
            "lg:absolute lg:inset-y-0 lg:right-12 lg:left-0 lg:z-30 lg:w-auto lg:max-w-none"
        )}
        style={{ flexBasis: width }}
      >
        {!expanded ? (
          <WorkspaceResizeHandle
            label="Resize coding workspace"
            width={width}
            min={360}
            max={1000}
            onResize={setWidth}
          />
        ) : null}
        <header className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b px-3">
          <span className="flex-1 text-sm font-semibold">
            {views.find((view) => view.id === tab)?.label}
          </span>
          {tab === "changes" && data ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {data.files.length} {data.files.length === 1 ? "file" : "files"}
            </span>
          ) : null}
          <Button
            className="hidden lg:inline-flex"
            aria-label={expanded ? "Restore panel size" : "Expand panel"}
            title={expanded ? "Restore panel size" : "Expand panel"}
            size="icon-sm"
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button
            aria-label="Close workspace panel"
            title="Close workspace panel"
            size="icon-sm"
            variant="ghost"
            onClick={() => setPanel((current) => ({ ...current, open: false }))}
          >
            <PanelRightClose />
          </Button>
        </header>
        {visited.has("files") ? (
          <div className={cn("min-h-0 flex-1", tab !== "files" && "hidden")}>
            <FilesWorkspace
              embedded
              agentName={tree.agent_name}
              sessionId={thread.session_id}
              workspaceId={workspaceId}
              onPreviewerOpenChange={onPreviewerOpenChange}
            />
          </div>
        ) : null}
        {visited.has("terminal") ? (
          <div className={cn("min-h-0 flex-1", tab !== "terminal" && "hidden")}>
            <CodingTerminal
              key={`${workspaceId}:${tree.agent_name}:${thread.session_id}:${tree.directory}`}
              agentName={tree.agent_name}
              sessionId={thread.session_id}
              directory={tree.directory}
              workspaceId={workspaceId}
              visible={open && tab === "terminal"}
              onLastTerminalClosed={() => {
                setPanel((current) =>
                  current.tab === "terminal" ? { ...current, open: false } : current
                )
              }}
            />
          </div>
        ) : null}
        {visited.has("changes") ? (
          <div className={cn("flex min-h-0 flex-1", tab !== "changes" && "hidden")}>
            <GitChanges
              thread={thread}
              workspaceId={workspaceId}
              status={status}
              visible={open && tab === "changes"}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
            />
          </div>
        ) : null}
        <footer className="bg-muted/20 text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-t px-2 text-[11px]">
          {data ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    role="combobox"
                    aria-label="Current branch"
                    aria-expanded={branchOpen}
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="min-w-0 flex-1 justify-start px-1 text-xs"
                  >
                    <GitBranch className="text-muted-foreground" />
                    <span className="truncate" title={data.branch}>
                      {data.branch || "Detached HEAD"}
                    </span>
                    <ChevronDown className="text-muted-foreground ml-auto" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
                  <Command>
                    <CommandInput placeholder="Find a branch..." />
                    {data.files.length > 0 ? (
                      <p className="text-muted-foreground border-b px-3 py-2 text-xs">
                        Commit or clear your changes before switching branches.
                      </p>
                    ) : null}
                    <CommandList>
                      <CommandEmpty>No branches found.</CommandEmpty>
                      <CommandGroup heading="Local branches">
                        {data.branches.map((branch) => (
                          <CommandItem
                            key={branch}
                            value={branch}
                            disabled={data.files.length > 0 && branch !== data.branch}
                            onSelect={() => {
                              setBranchOpen(false)
                              if (branch !== data.branch) checkout.mutate(branch)
                            }}
                          >
                            <GitBranch />
                            <span className="truncate" title={branch}>
                              {branch}
                            </span>
                            {branch === data.branch ? <Check className="ml-auto" /> : null}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
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
      </aside>
      <nav
        aria-label="Workspace tools"
        className="bg-sidebar flex w-12 shrink-0 flex-col items-center gap-1 border-l py-2"
      >
        {views.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                aria-label={label}
                aria-pressed={open && tab === id}
                variant={open && tab === id ? "secondary" : "ghost"}
                size="icon"
                className={cn("relative", open && tab === id && "text-primary")}
                onClick={() => {
                  setPanel((current) => ({
                    tab: id,
                    open: current.tab === id ? !current.open : true,
                  }))
                  setVisited((current) => new Set(current).add(id))
                }}
              >
                <Icon />
                {id === "changes" && data && data.files.length > 0 ? (
                  <span className="bg-primary text-primary-foreground absolute top-0 right-0 min-w-3.5 rounded-full px-0.5 text-[9px] leading-3.5 tabular-nums">
                    {data.files.length}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{label}</TooltipContent>
          </Tooltip>
        ))}
      </nav>
    </>
  )
}
