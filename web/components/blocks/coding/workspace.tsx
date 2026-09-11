"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import { useTheme } from "next-themes"
import {
  Activity,
  Bot,
  Brain,
  CheckCircle2,
  Circle,
  CircleSlash,
  Coins,
  Cpu,
  Database,
  Gauge,
  MessageSquare,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  ExternalLink,
  FileCode2,
  FolderCode,
  CircleDot,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  ListTodo,
  Maximize2,
  Minimize2,
  Minus,
  PanelRightClose,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  TerminalSquare,
  TextWrap,
} from "lucide-react"
import { toast } from "sonner"
import { DEFAULT_THEMES, parsePatchFiles, preloadHighlighter } from "@pierre/diffs"
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { remoteCodingGit, codingGitHubInfo, createCodingPullRequest } from "@/lib/coding/actions"
import { runCodingGit, type CodingThread, type CodingGitRequest } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { cn } from "@/lib/utils"

// Plain-text diffs need the highlighter ready before their first render.
const FileDiff = dynamic(
  async () => {
    const [module] = await Promise.all([
      import("@pierre/diffs/react"),
      preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] }),
    ])
    return module.FileDiff
  },
  {
    ssr: false,
    loading: () => <Skeleton className="m-3 h-16" />,
  }
)

const CodingTerminal = dynamic(() => import("./terminal").then((module) => module.CodingTerminal), {
  ssr: false,
})
const FilesWorkspace = dynamic(
  () => import("../chat/files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false }
)
const views = [
  { id: "files", label: "Files", icon: Files },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "github", label: "GitHub", icon: GitPullRequest },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "context", label: "Session context", icon: ListTodo },
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
  const { resolvedTheme } = useTheme()
  const { pendingPreview, previewFile } = useFileWorkspace()
  const [tab, setTab] = useState<View>("changes")
  const [open, setOpen] = useState(false)
  const [visited, setVisited] = useState<Set<View>>(new Set())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [staged, setStaged] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [filter, setFilter] = useState("")
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [message, setMessage] = useState("")
  const [prOpen, setPrOpen] = useState(false)
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [pending, startTransition] = useTransition()
  const tree = thread.worktree
  const status = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
      queryFn: () => localGit(workspaceId, tree.id, { operation: "status" }),
      refetchInterval: open && !pending ? 5000 : false,
    })
  )
  const github = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: [
        "coding",
        "github",
        workspaceId,
        tree.id,
        status.data?.branch,
        tree.agent_name,
        thread.session_id,
        actor?.user.id,
      ],
      queryFn: ({ pageParam }) =>
        codingGitHubInfo(workspaceId, tree.agent_name, thread.session_id, pageParam),
      initialPageParam: 1,
      getNextPageParam: (lastPage) => lastPage.nextPage,
      enabled:
        open && tab === "github" && actor?.user.id !== undefined && status.data !== undefined,
    })
  )
  const githubInfo = github.data?.pages[0]
  const data = status.error ? undefined : status.data
  const patch = staged ? data?.staged_diff : data?.diff
  const diffs = useMemo(
    () => (patch ? parsePatchFiles(patch).flatMap((patch) => patch.files) : []),
    [patch]
  )
  const diff = diffs.find((file) => file.name === selected) ?? diffs[0]
  const stagedFiles = data?.files.filter((file) => file.index !== " " && file.index !== "?") ?? []
  const changedFiles = data?.files.filter((file) => file.worktree !== " ") ?? []
  const reviewedFiles = staged ? stagedFiles : changedFiles
  // Git quotes control characters in patch headers. Preserve those names and
  // expose their diffs without maintaining another Git path parser.
  const escapedDiffs = diffs.filter(
    (diff) => !reviewedFiles.some((file) => file.path === diff.name)
  )

  const [handledPreview, setHandledPreview] = useState<typeof pendingPreview>()
  if (pendingPreview?.agent === tree.agent_name && pendingPreview !== handledPreview) {
    setHandledPreview(pendingPreview)
    setTab("files")
    setVisited((current) => new Set(current).add("files"))
    setOpen(true)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.code === "KeyB" && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        setOpen((value) => !value)
      }
      if (event.key === "`") {
        event.preventDefault()
        event.stopPropagation()
        setTab("terminal")
        setVisited((current) => new Set(current).add("terminal"))
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  // Keep the expected HEAD attached to each operation, including bulk staging.
  function changeIndex(operation: "stage" | "unstage", paths: string[]) {
    if (!data) return
    startTransition(async () => {
      try {
        await localGit(workspaceId, tree.id, { operation, paths, expected_head: data.head })
        if (!selected || paths.includes(selected)) setStaged(operation === "stage")
        await status.refetch()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not update staged files")
      }
    })
  }

  function syncGit(body: Parameters<typeof remoteCodingGit>[3]) {
    startTransition(async () => {
      try {
        await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, body)
        if (body.operation === "commit") setMessage("")
        await status.refetch()
        if (tab === "github") await github.refetch()
        toast.success({ commit: "Committed", pull: "Pulled", push: "Pushed" }[body.operation])
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not update checkout")
      }
    })
  }

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
          {tab === "changes" || tab === "github" ? (
            <Button
              aria-label="Refresh changes"
              title="Refresh changes"
              size="icon-sm"
              variant="ghost"
              disabled={status.isFetching || pending}
              onClick={() => {
                void status.refetch()
                if (tab === "github") void github.refetch()
              }}
            >
              <RefreshCw className={cn(status.isFetching && "animate-spin")} />
            </Button>
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
            onClick={() => setOpen(false)}
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
              agentName={tree.agent_name}
              sessionId={thread.session_id}
              directory={tree.directory}
              workspaceId={workspaceId}
              visible={open && tab === "terminal"}
            />
          </div>
        ) : null}
        {tab === "context" ? <SessionContext thread={thread} workspaceId={workspaceId} /> : null}
        {tab === "changes" || tab === "github" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {status.isPending ? (
              <div
                role="status"
                className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm"
              >
                <Spinner /> Loading repository...
              </div>
            ) : null}
            {status.error ? (
              <div
                role="alert"
                className="text-muted-foreground flex flex-col items-center gap-3 p-6 text-center text-sm"
              >
                Could not load changes.
                <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
                  <RefreshCw /> Retry
                </Button>
              </div>
            ) : null}
            {data && tab === "changes" ? (
              <>
                {data.files.length > 0 ? (
                  <Tabs
                    value={staged ? "staged" : "working"}
                    onValueChange={(value) => {
                      setStaged(value === "staged")
                      setSelected(undefined)
                    }}
                    className="min-h-0 flex-1 gap-0"
                  >
                    <div className="relative m-3 mb-1">
                      <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5" />
                      <Input
                        aria-label="Filter changed files"
                        placeholder="Filter changed files..."
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        className="h-8 pl-8 text-xs"
                      />
                    </div>
                    <div className="max-h-[35%] shrink-0 overflow-y-auto border-b pb-1">
                      {[
                        { label: "Staged changes", files: stagedFiles, staged: true },
                        { label: "Changes", files: changedFiles, staged: false },
                      ].map((group) => (
                        <details key={group.label} open className="group/files">
                          <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 px-3 py-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="size-3.5 group-open/files:rotate-90" />
                            {group.label}
                            <span className="ml-1 tabular-nums">{group.files.length}</span>
                            <Button
                              type="button"
                              aria-label={group.staged ? "Unstage all files" : "Stage all files"}
                              title={group.staged ? "Unstage all files" : "Stage all files"}
                              className="ml-auto"
                              size="icon-xs"
                              variant="ghost"
                              disabled={pending || !group.files.length}
                              onClick={(event) => {
                                event.preventDefault()
                                changeIndex(
                                  group.staged ? "unstage" : "stage",
                                  group.files.flatMap((file) =>
                                    group.staged && file.previous_path
                                      ? [file.path, file.previous_path]
                                      : [file.path]
                                  )
                                )
                              }}
                            >
                              {group.staged ? <Minus /> : <Plus />}
                            </Button>
                          </summary>
                          {group.files
                            .filter((file) =>
                              file.path.toLowerCase().includes(filter.toLowerCase())
                            )
                            .map((file) => (
                              <div
                                key={file.path}
                                className={cn(
                                  "group/file flex items-center gap-1 pr-2 pl-5",
                                  staged === group.staged && diff?.name === file.path
                                    ? "bg-accent"
                                    : "hover:bg-accent/50"
                                )}
                              >
                                <button
                                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs"
                                  title={
                                    file.previous_path
                                      ? `${file.previous_path} → ${file.path}`
                                      : file.path
                                  }
                                  onClick={() => {
                                    setSelected(file.path)
                                    setStaged(group.staged)
                                  }}
                                >
                                  <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
                                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                                  <span
                                    className={cn(
                                      "font-mono",
                                      file.index === "?"
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground"
                                    )}
                                  >
                                    {group.staged ? file.index : file.worktree}
                                  </span>
                                </button>
                                <Button
                                  aria-label={`Open ${file.path}`}
                                  title="Open file"
                                  disabled={file.worktree === "D" || file.index === "D"}
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={() =>
                                    previewFile(tree.agent_name, {
                                      name: file.path.slice(file.path.lastIndexOf("/") + 1),
                                      path: `${tree.directory.slice("/home/agentz/".length)}/${file.path}`,
                                    })
                                  }
                                >
                                  <ExternalLink />
                                </Button>
                                <Button
                                  aria-label={`${group.staged ? "Unstage" : "Stage"} ${file.path}`}
                                  title={group.staged ? "Unstage file" : "Stage file"}
                                  size="icon-xs"
                                  variant="ghost"
                                  disabled={pending}
                                  onClick={() =>
                                    changeIndex(
                                      group.staged ? "unstage" : "stage",
                                      group.staged && file.previous_path
                                        ? [file.path, file.previous_path]
                                        : [file.path]
                                    )
                                  }
                                >
                                  {group.staged ? <Minus /> : <Plus />}
                                </Button>
                              </div>
                            ))}
                          {!group.files.length ? (
                            <p className="text-muted-foreground px-7 py-1.5 text-xs">
                              {group.staged ? "No staged files" : "No unstaged files"}
                            </p>
                          ) : null}
                        </details>
                      ))}
                      {escapedDiffs.map((diff) => (
                        <Button
                          key={diff.name}
                          size="sm"
                          variant="ghost"
                          className="w-full justify-start truncate px-5 text-xs"
                          onClick={() => setSelected(diff.name)}
                        >
                          <FileCode2 /> Review {diff.name}
                        </Button>
                      ))}
                      {filter &&
                      !data.files.some((file) =>
                        file.path.toLowerCase().includes(filter.toLowerCase())
                      ) ? (
                        <p className="text-muted-foreground px-4 py-3 text-xs">
                          No files match &quot;{filter}&quot;.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
                      <TabsList aria-label="Changes to review">
                        <TabsTrigger value="working">Working</TabsTrigger>
                        <TabsTrigger value="staged">Staged</TabsTrigger>
                      </TabsList>
                      <div className="flex-1" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant={split ? "secondary" : "ghost"}
                            aria-label={split ? "Use unified diff" : "Use split diff"}
                            aria-pressed={split}
                            onClick={() => setSplit(!split)}
                          >
                            {split ? <Columns2 /> : <Rows3 />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {split ? "Use unified diff" : "Use split diff"}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant={wrap ? "secondary" : "ghost"}
                            aria-label="Wrap diff lines"
                            aria-pressed={wrap}
                            onClick={() => setWrap(!wrap)}
                          >
                            <TextWrap />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Wrap diff lines</TooltipContent>
                      </Tooltip>
                    </div>
                    <TabsContent
                      value={staged ? "staged" : "working"}
                      className="flex min-h-0 flex-col"
                    >
                      {diff &&
                      (!selected ||
                        diffs.some((file) => file.name === selected) ||
                        !reviewedFiles.some((file) => file.path === selected)) ? (
                        <>
                          <div className="text-muted-foreground flex items-center gap-1 px-3 py-1.5 text-xs">
                            <span className="min-w-0 flex-1 truncate" title={diff.name}>
                              {diff.name}
                            </span>
                            <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
                              +{diff.hunks.reduce((count, hunk) => count + hunk.additionLines, 0)}
                            </span>
                            <span className="text-destructive mr-2 tabular-nums">
                              -{diff.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0)}
                            </span>
                            <span className="tabular-nums">
                              {diffs.indexOf(diff) + 1}/{diffs.length}
                            </span>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Previous changed file"
                              disabled={diffs.indexOf(diff) === 0}
                              onClick={() => setSelected(diffs[diffs.indexOf(diff) - 1]?.name)}
                            >
                              <ChevronLeft />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Next changed file"
                              disabled={diffs.indexOf(diff) === diffs.length - 1}
                              onClick={() => setSelected(diffs[diffs.indexOf(diff) + 1]?.name)}
                            >
                              <ChevronRight />
                            </Button>
                          </div>
                          <div className="min-h-0 flex-1 overflow-auto">
                            {diff.hunks.length === 0 ? (
                              <Empty>
                                <EmptyHeader>
                                  <EmptyMedia variant="icon">
                                    <FileCode2 />
                                  </EmptyMedia>
                                  <EmptyTitle>
                                    {diff.type === "rename-pure"
                                      ? "File renamed"
                                      : "No line changes"}
                                  </EmptyTitle>
                                  <EmptyDescription>
                                    {diff.prevName
                                      ? `${diff.prevName} → ${diff.name}`
                                      : "This change affects binary content or file metadata."}
                                  </EmptyDescription>
                                </EmptyHeader>
                              </Empty>
                            ) : (
                              <FileDiff
                                className="[font-stretch:normal]"
                                fileDiff={diff}
                                options={{
                                  diffStyle: split ? "split" : "unified",
                                  overflow: wrap ? "wrap" : "scroll",
                                  themeType: resolvedTheme === "dark" ? "dark" : "light",
                                  disableFileHeader: true,
                                }}
                              />
                            )}
                          </div>
                        </>
                      ) : (
                        <Empty>
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <FileCode2 />
                            </EmptyMedia>
                            <EmptyTitle>{staged ? "No staged diff" : "No tracked diff"}</EmptyTitle>
                            <EmptyDescription>
                              {escapedDiffs.length
                                ? "Choose the escaped path in the file list to review its diff."
                                : staged
                                  ? "Stage changes to review them here."
                                  : "New files appear in the diff after staging. Use Open file to inspect their contents."}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      )}
                    </TabsContent>
                  </Tabs>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Check />
                      </EmptyMedia>
                      <EmptyTitle>Working tree is clean</EmptyTitle>
                      <EmptyDescription>
                        Changes made by you or the agent will appear here.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </>
            ) : null}
            {tab === "changes" && data && stagedFiles.length > 0 ? (
              <form
                className="flex shrink-0 flex-col gap-2 border-t p-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const treeHash = data.tree
                  if (!treeHash) return
                  syncGit({ operation: "commit", head: data.head, tree: treeHash, message })
                }}
              >
                <Textarea
                  aria-label="Commit message"
                  value={message}
                  maxLength={20_000}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Leave empty to generate a message"
                  disabled={pending}
                  className="min-h-16 resize-none text-xs"
                />
                <Button type="submit" size="sm" disabled={pending || !data.tree}>
                  {pending ? <Spinner /> : <GitCommitHorizontal />} Commit {stagedFiles.length}{" "}
                  staged {stagedFiles.length === 1 ? "file" : "files"}
                </Button>
              </form>
            ) : null}
            {tab === "github" && data ? (
              <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
                {github.error ? (
                  <p role="alert" className="text-destructive text-sm">
                    Could not load GitHub. Check your account connection and repository access.
                  </p>
                ) : null}
                {github.isPending ? (
                  <p className="text-muted-foreground text-sm">Loading GitHub...</p>
                ) : null}
                {github.data && githubInfo && !github.error ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          pending ||
                          !githubInfo.branchHead ||
                          data.files.length > 0 ||
                          githubInfo.branchHead === data.head
                        }
                        onClick={() => syncGit({ operation: "pull", head: data.head })}
                      >
                        <ArrowDown />
                        Pull
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending || githubInfo.branchHead === data.head}
                        onClick={() =>
                          syncGit({
                            operation: "push",
                            head: data.head,
                            remoteHead: githubInfo.branchHead,
                          })
                        }
                      >
                        <ArrowUp />
                        {githubInfo.branchHead ? "Push" : "Publish branch"}
                      </Button>
                      <Dialog open={prOpen} onOpenChange={setPrOpen}>
                        <DialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              pending ||
                              data.branch === githubInfo.defaultBranch ||
                              githubInfo.branchHead !== data.head
                            }
                          >
                            <GitPullRequest /> New pull request
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>New pull request</DialogTitle>
                            <DialogDescription className="break-all">
                              {data.branch} into {githubInfo.defaultBranch}
                            </DialogDescription>
                          </DialogHeader>
                          <form
                            className="grid gap-3"
                            onSubmit={(event) => {
                              event.preventDefault()
                              const base = githubInfo.defaultBranch
                              startTransition(async () => {
                                try {
                                  const url = await createCodingPullRequest(
                                    workspaceId,
                                    tree.agent_name,
                                    thread.session_id,
                                    prTitle,
                                    prBody,
                                    base
                                  )
                                  toast.success("Pull request ready", {
                                    action: {
                                      label: "Open",
                                      onClick: () =>
                                        window.open(url, "_blank", "noopener,noreferrer"),
                                    },
                                  })
                                  setPrOpen(false)
                                  await github.refetch()
                                } catch {
                                  toast.error(
                                    "Could not create the pull request. Check repository access and push the branch first."
                                  )
                                }
                              })
                            }}
                          >
                            <Input
                              disabled={pending}
                              aria-label="Pull request title"
                              placeholder="Title"
                              value={prTitle}
                              onChange={(event) => setPrTitle(event.target.value)}
                              maxLength={256}
                            />
                            <Textarea
                              maxLength={65_536}
                              disabled={pending}
                              aria-label="Pull request description"
                              placeholder="Describe your changes"
                              value={prBody}
                              onChange={(event) => setPrBody(event.target.value)}
                              className="min-h-24 rounded-md border p-2 text-sm"
                            />
                            <Button
                              variant="outline"
                              type="submit"
                              disabled={
                                pending ||
                                !prTitle.trim() ||
                                data.branch === githubInfo.defaultBranch ||
                                githubInfo.branchHead !== data.head
                              }
                            >
                              <GitPullRequest />
                              Create pull request
                            </Button>
                          </form>
                        </DialogContent>
                      </Dialog>
                    </div>
                    {[
                      {
                        label: "Pull requests",
                        icon: GitPullRequest,
                        items: github.data.pages.flatMap((page) => page.pulls),
                        empty: "No open pull requests",
                      },
                      {
                        label: "Issues",
                        icon: CircleDot,
                        items: github.data.pages.flatMap((page) => page.issues),
                        empty: "No open issues",
                      },
                    ].map(({ label, icon: Icon, items, empty }) => (
                      <section key={label}>
                        <h3 className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium">
                          <Icon className="size-3.5" />
                          {label}
                          <span className="ml-auto tabular-nums">{items.length}</span>
                        </h3>
                        {items.length ? (
                          items.map((item) => (
                            <a
                              key={item.number}
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:bg-muted focus-visible:ring-ring group flex items-start gap-2 rounded-md px-2 py-2 text-xs outline-none focus-visible:ring-2"
                            >
                              <span className="text-muted-foreground shrink-0 tabular-nums">
                                #{item.number}
                              </span>
                              <span className="min-w-0 flex-1 leading-relaxed">{item.title}</span>
                              <ExternalLink className="text-muted-foreground mt-0.5 size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                            </a>
                          ))
                        ) : (
                          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-5 text-center text-xs">
                            {empty}
                          </p>
                        )}
                      </section>
                    ))}
                    {github.hasNextPage ? (
                      <Button
                        variant="outline"
                        disabled={github.isFetchingNextPage}
                        onClick={() => void github.fetchNextPage()}
                      >
                        {github.isFetchingNextPage ? <Spinner /> : <Plus />}
                        Load more pull requests and issues
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
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
                              if (branch !== data.branch) {
                                startTransition(async () => {
                                  try {
                                    await localGit(workspaceId, tree.id, {
                                      operation: "checkout",
                                      ref: branch,
                                      expected_head: data.head,
                                    })
                                    setSelected(undefined)
                                    await status.refetch()
                                  } catch (error) {
                                    toast.error(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not switch branch"
                                    )
                                  }
                                })
                              }
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
            <TooltipContent side="top" className="max-w-sm break-all">
              {thread.repository} · {tree.shared ? "Shared checkout" : "Worktree"}
              <br />
              {tree.directory}
            </TooltipContent>
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
                  setOpen(tab === id ? !open : true)
                  setTab(id)
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
            <TooltipContent side="left">
              {label}
              {id === "terminal" ? " · Ctrl+`" : ""}
            </TooltipContent>
          </Tooltip>
        ))}
      </nav>
    </>
  )
}

function SessionContext({ thread, workspaceId }: { thread: CodingThread; workspaceId: string }) {
  const context = useQuery(
    queryOptions({
      queryKey: [
        "coding",
        "context",
        workspaceId,
        thread.id,
        thread.worktree.agent_name,
        thread.worktree.directory,
        thread.session_id,
      ],
      queryFn: async ({ signal }) => {
        const client = await createAgentOpencodeClient(thread.worktree.agent_name, workspaceId)
        const params = { directory: thread.worktree.directory, sessionID: thread.session_id }
        const [messages, todos] = await Promise.all([
          client.session.messages(params, { signal, throwOnError: true }),
          client.session.todo(params, { signal, throwOnError: true }),
        ])
        return { messages: messages.data, todos: todos.data }
      },
      refetchInterval: 5000,
    })
  )
  if (context.isPending) {
    return (
      <div role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
        <Spinner /> Loading session...
      </div>
    )
  }
  if (context.isError) {
    return (
      <div
        role="alert"
        className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm"
      >
        Could not load session context.
        <Button size="sm" variant="outline" onClick={() => void context.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const assistants = context.data.messages.flatMap((message) =>
    message.info.role === "assistant" ? [message.info] : []
  )
  const last = assistants.at(-1)
  const cost = assistants.reduce((sum, message) => sum + message.cost, 0)
  const todos = context.data.todos
  const completed = todos.filter((todo) => todo.status === "completed").length
  return (
    <div className="min-h-0 flex-1 overflow-auto text-sm">
      <section className="border-b p-4">
        <h3 className="mb-4 flex items-center gap-2 font-semibold">
          <span className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
            <Activity className="size-4" />
          </span>
          Session
        </h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
          <dt className="text-muted-foreground flex items-center gap-2">
            <Bot className="size-3.5" /> Agent
          </dt>
          <dd className="truncate text-right font-medium" title={thread.worktree.agent_name}>
            {thread.worktree.agent_name}
          </dd>
          <dt className="text-muted-foreground flex items-center gap-2">
            <Cpu className="size-3.5" /> Model
          </dt>
          <dd className="truncate text-right font-medium" title={last?.modelID}>
            {last?.modelID ?? "No response yet"}
          </dd>
          <dt className="text-muted-foreground flex items-center gap-2">
            <MessageSquare className="size-3.5" /> Messages
          </dt>
          <dd className="text-right font-medium tabular-nums">
            {context.data.messages.length.toLocaleString()}
          </dd>
          <dt className="text-muted-foreground flex items-center gap-2">
            <Coins className="size-3.5" /> Session cost
          </dt>
          <dd className="text-info text-right font-medium tabular-nums">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 4,
            }).format(cost)}
          </dd>
        </dl>
      </section>
      {last ? (
        <section className="border-b p-4">
          <h3 className="mb-4 flex items-center gap-2 font-semibold">
            <span className="bg-warning/10 text-warning flex size-7 items-center justify-center rounded-md">
              <Gauge className="size-4" />
            </span>
            Last response tokens
          </h3>
          <dl className="bg-muted/20 divide-y rounded-lg border px-3">
            {[
              {
                label: "Input",
                count: last.tokens.input,
                icon: ArrowDown,
                color: "text-info",
              },
              {
                label: "Output",
                count: last.tokens.output,
                icon: ArrowUp,
                color: "text-primary",
              },
              {
                label: "Reasoning",
                count: last.tokens.reasoning,
                icon: Brain,
                color: "text-primary",
              },
              {
                label: "Cache read",
                count: last.tokens.cache.read,
                icon: Database,
                color: "text-muted-foreground",
              },
              {
                label: "Cache write",
                count: last.tokens.cache.write,
                icon: Database,
                color: "text-muted-foreground",
              },
            ].map(({ label, count, icon: Icon, color }) => (
              <div key={label} className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-muted-foreground flex items-center gap-2">
                  <Icon className={cn("size-3.5", color)} />
                  {label}
                </dt>
                <dd className="font-medium tabular-nums">{count.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <section className="p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold">
            <span className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
              <ListTodo className="size-4" />
            </span>
            Tasks
          </h3>
          {todos.length > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {completed} of {todos.length} complete
            </span>
          ) : null}
        </div>
        {todos.length ? (
          <>
            <Progress
              aria-label="Completed tasks"
              value={(completed / todos.length) * 100}
              className="mb-2"
            />
            <ul className="divide-y">
              {todos.map((todo, index) => (
                <li key={index} className="flex items-start gap-2.5 py-3">
                  {todo.status === "completed" ? (
                    <CheckCircle2 className="text-primary mt-0.5 size-4 shrink-0" />
                  ) : todo.status === "in_progress" ? (
                    <Spinner className="text-primary mt-0.5 size-4 shrink-0" />
                  ) : todo.status === "cancelled" ? (
                    <CircleSlash className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  ) : (
                    <Circle className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 leading-5 break-words",
                      (todo.status === "completed" || todo.status === "cancelled") &&
                        "text-muted-foreground line-through"
                    )}
                  >
                    {todo.content}
                  </span>
                  <Badge
                    className="mt-0.5"
                    variant={
                      todo.priority === "high" &&
                      todo.status !== "completed" &&
                      todo.status !== "cancelled"
                        ? "warning"
                        : "pending"
                    }
                  >
                    {todo.priority}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No tasks yet</EmptyTitle>
              <EmptyDescription>
                The agent&apos;s task list will appear here as it works.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  )
}

async function localGit(workspaceId: string, worktreeId: string, body: CodingGitRequest) {
  const result = await runCodingGit({
    baseUrl: await getGatewayBaseURL(),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { worktreeId },
    body,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}
