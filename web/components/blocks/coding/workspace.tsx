"use client"

import { useEffect, useState, useTransition } from "react"
import dynamic from "next/dynamic"
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
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
  ExternalLink,
  FolderCode,
  CircleDot,
  Files,
  GitBranch,
  GitPullRequest,
  ListTodo,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  RefreshCw,
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
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { remoteCodingGit, codingGitHubInfo, createCodingPullRequest } from "@/lib/coding/actions"
import { type CodingThread } from "@/lib/gateway/client"
import { runWorkspaceGit } from "@/lib/coding/review"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { cn } from "@/lib/utils"

const GitChanges = dynamic(() => import("./git").then((module) => module.GitChanges), {
  ssr: false,
  loading: () => <Skeleton className="m-3 h-16" />,
})

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
  const { pendingPreview } = useFileWorkspace()
  const [tab, setTab] = useState<View>("changes")
  const [open, setOpen] = useState(false)
  const [visited, setVisited] = useState<Set<View>>(new Set())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [pending, startTransition] = useTransition()
  const tree = thread.worktree
  const status = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
      queryFn: () => runWorkspaceGit(workspaceId, tree.id, { operation: "status" }),
      refetchInterval: open && (tab === "changes" || tab === "github") && !pending ? 5000 : false,
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
  const data = status.data

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
        setVisited((current) => new Set(current).add(tab))
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
  }, [tab])

  function syncGit(body: Parameters<typeof remoteCodingGit>[3]) {
    startTransition(async () => {
      try {
        await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, body)
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
          {tab === "github" ? (
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
        {tab === "context" ? <SessionContext thread={thread} workspaceId={workspaceId} /> : null}
        {tab === "github" ? (
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
                                    await runWorkspaceGit(workspaceId, tree.id, {
                                      operation: "checkout",
                                      ref: branch,
                                      expected_head: data.head,
                                    })
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
