"use client"

import { useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  FileDiff,
  FilePenLine,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { DEFAULT_THEMES, parsePatchFiles, preloadHighlighter } from "@pierre/diffs"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { WorkspaceResizeHandle } from "@/components/blocks/chat/files-workspace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { GitHubLight, GitHubDark } from "@ridemountainpig/svgl-react"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"
import { remoteCodingGit, codingGitHubInfo, createCodingPullRequest } from "@/lib/coding/actions"
import { runCodingGit, type CodingThread, type CodingGitRequest } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

// Plain-text diffs need the highlighter ready before their first render.
const FileDiffView = dynamic(
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

export function CodingReview({
  thread,
  workspaceId,
  onClose,
  open,
}: {
  thread: CodingThread
  workspaceId: string
  onClose: () => void
  open: boolean
}) {
  const { data: actor } = authClient.useSession()
  const { resolvedTheme } = useTheme()
  const { previewFile } = useFileWorkspace()
  const [branchOpen, setBranchOpen] = useState(false)
  const [width, setWidth] = useState(480)
  const [tab, setTab] = useState("changes")
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [staged, setStaged] = useState(false)
  const [message, setMessage] = useState("")
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [pending, startTransition] = useTransition()
  const tree = thread.worktree
  const status = useQuery(
    queryOptions({
      queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
      queryFn: () => localGit(workspaceId, tree.id, { operation: "status" }),
      enabled: open,
      refetchInterval: pending || !open || tab === "terminal" ? false : 5000,
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
      enabled: open && tab === "github" && Boolean(actor) && Boolean(status.data),
    })
  )
  const githubInfo = github.data?.pages[0]
  function changeGit(body: CodingGitRequest) {
    startTransition(async () => {
      try {
        await localGit(workspaceId, tree.id, body)
        await status.refetch()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not update checkout")
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

  const data = status.data
  const workingFiles = data?.files.filter((file) => file.worktree !== " ") ?? []
  const stagedFiles = data?.files.filter((file) => file.index !== " " && file.index !== "?") ?? []
  const files = staged ? stagedFiles : workingFiles
  const diffFiles = new Map(
    parsePatchFiles((staged ? data?.staged_diff : data?.diff) ?? "").flatMap((patch) =>
      patch.files.map((file) => [file.name, file] as const)
    )
  )
  const paths = new Set(files.map((file) => file.path))
  // Pierre preserves Git escapes in unusual filenames. Keep those diffs visible
  // through its own headers instead of decoding paths with another parser.
  const additionalDiffs = [...diffFiles.values()].filter((file) => !paths.has(file.name))
  return (
    <aside
      aria-label="Code"
      style={{ width }}
      className={cn(
        "bg-background relative flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden border-l max-lg:w-full! lg:max-w-[60%]",
        !open && "hidden"
      )}
    >
      <WorkspaceResizeHandle
        label="Resize code panel"
        width={width}
        min={360}
        max={960}
        onResize={setWidth}
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value)
          if (value === "terminal") setTerminalOpened(true)
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b px-3">
          <TabsList aria-label="Code workspace">
            <TabsTrigger value="changes">
              <FileDiff data-icon="inline-start" />
              Changes
            </TabsTrigger>
            <TabsTrigger value="github">
              <GitHubLight data-icon="inline-start" className="dark:hidden" />
              <GitHubDark data-icon="inline-start" className="hidden dark:block" />
              GitHub
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <TerminalSquare data-icon="inline-start" />
              <span className="sr-only sm:not-sr-only">Terminal</span>
            </TabsTrigger>
          </TabsList>
          <Button
            className="ml-auto"
            size="icon-sm"
            aria-label="Close code panel"
            variant="ghost"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        {terminalOpened ? (
          <TabsContent
            forceMount
            value="terminal"
            className="flex min-h-0 flex-col data-[state=inactive]:hidden"
          >
            <CodingTerminal
              agentName={tree.agent_name}
              sessionId={thread.session_id}
              directory={tree.directory}
              workspaceId={workspaceId}
              active={open && tab === "terminal"}
              branch={data?.branch ?? tree.branch}
            />
          </TabsContent>
        ) : null}
        {tab !== "terminal" ? (
          <TabsContent value={tab} className="flex min-h-0 flex-col overflow-auto">
            {status.error ? (
              <div className="p-4">
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription>
                    Changes are unavailable.
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={status.isFetching}
                      onClick={() => void status.refetch()}
                    >
                      <RefreshCw /> Retry
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
            {status.isPending ? (
              <div role="status" aria-label="Loading changes" className="flex flex-col gap-3 p-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-3/4" />
              </div>
            ) : null}
            {data ? (
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
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
                                  changeGit({
                                    operation: "checkout",
                                    ref: branch,
                                    expected_head: data.head,
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      aria-label="Refresh changes"
                      variant="ghost"
                      disabled={status.isFetching || pending}
                      onClick={() => {
                        void status.refetch()
                        if (tab === "github") void github.refetch()
                      }}
                    >
                      <RefreshCw />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh changes</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
            {tab === "changes" && data ? (
              <>
                {!data.files.length ? (
                  <div
                    className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm"
                    role="status"
                  >
                    <Check className="text-primary/60 size-5" aria-hidden="true" />
                    No uncommitted changes
                  </div>
                ) : (
                  <Tabs
                    value={staged ? "staged" : "working"}
                    onValueChange={(value) => setStaged(value === "staged")}
                    className="min-h-0 flex-1 gap-0"
                  >
                    <div className="flex shrink-0 items-center justify-between border-b px-3 py-1">
                      <TabsList aria-label="Diff to review">
                        <TabsTrigger value="working">
                          Changes{" "}
                          <span className="text-muted-foreground tabular-nums">
                            {workingFiles.length}
                          </span>
                        </TabsTrigger>
                        <TabsTrigger value="staged">
                          Staged{" "}
                          <span className="text-muted-foreground tabular-nums">
                            {stagedFiles.length}
                          </span>
                        </TabsTrigger>
                      </TabsList>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={staged ? "Unstage all" : "Stage all"}
                        disabled={pending || !files.length}
                        onClick={() =>
                          changeGit({
                            operation: staged ? "unstage" : "stage",
                            paths: files.flatMap((file) => [
                              file.path,
                              ...(staged && file.previous_path ? [file.previous_path] : []),
                            ]),
                            expected_head: data.head,
                          })
                        }
                      >
                        {staged ? <Minus /> : <Plus />}
                      </Button>
                    </div>
                    <TabsContent
                      value={staged ? "staged" : "working"}
                      className="min-h-0 overflow-auto"
                    >
                      {files.map((file) => {
                        const diff = diffFiles.get(file.path)
                        const code = staged ? file.index : file.worktree
                        const slash = file.path.lastIndexOf("/")
                        return (
                          <Collapsible key={file.path} defaultOpen className="border-b">
                            <div className="bg-muted/30 flex items-center gap-1 px-2">
                              <CollapsibleTrigger asChild>
                                <Button
                                  variant="ghost"
                                  className="group h-9 min-w-0 flex-1 justify-start gap-2 rounded-none px-1 font-normal"
                                  aria-label={`Review ${file.path}`}
                                >
                                  <ChevronRight className="text-muted-foreground size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                                  <span
                                    className="flex min-w-0 flex-1 items-baseline gap-2 text-xs"
                                    title={file.path}
                                  >
                                    <span className="truncate">{file.path.slice(slash + 1)}</span>
                                    {slash >= 0 ? (
                                      <span className="text-muted-foreground truncate">
                                        {file.path.slice(0, slash)}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span
                                    className={cn(
                                      "font-mono text-xs",
                                      code === "D"
                                        ? "text-destructive"
                                        : code === "A" || code === "?"
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-warning"
                                    )}
                                  >
                                    {code}
                                  </span>
                                </Button>
                              </CollapsibleTrigger>
                              {file.worktree !== "D" && file.index !== "D" ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      className="hidden lg:inline-flex"
                                      aria-label={`Open ${file.path} in editor`}
                                      onClick={() =>
                                        previewFile(tree.agent_name, {
                                          name: file.path.slice(slash + 1),
                                          path: `${tree.directory.slice("/home/agentz/".length)}/${file.path}`,
                                        })
                                      }
                                    >
                                      <FilePenLine />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Open in editor</TooltipContent>
                                </Tooltip>
                              ) : null}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={`${staged ? "Unstage" : "Stage"} ${file.path}`}
                                    disabled={pending}
                                    onClick={() =>
                                      changeGit({
                                        operation: staged ? "unstage" : "stage",
                                        paths: [
                                          file.path,
                                          ...(staged && file.previous_path
                                            ? [file.previous_path]
                                            : []),
                                        ],
                                        expected_head: data.head,
                                      })
                                    }
                                  >
                                    {staged ? <Minus /> : <Plus />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {staged ? "Unstage file" : "Stage file"}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                            <CollapsibleContent>
                              {file.previous_path ? (
                                <p className="text-muted-foreground px-3 py-2 text-xs">
                                  Renamed from {file.previous_path}
                                </p>
                              ) : null}
                              {diff?.hunks.length ? (
                                <FileDiffView
                                  fileDiff={diff}
                                  options={{
                                    diffStyle: "unified",
                                    disableFileHeader: true,
                                    themeType: resolvedTheme === "dark" ? "dark" : "light",
                                  }}
                                />
                              ) : (
                                <p className="text-muted-foreground px-3 py-4 text-xs">
                                  {code === "?"
                                    ? "Stage this file to preview its diff."
                                    : diff
                                      ? "No line changes to display."
                                      : additionalDiffs.length
                                        ? "See the escaped path in the diff below."
                                        : "Diff preview unavailable for this path."}
                                </p>
                              )}
                            </CollapsibleContent>
                          </Collapsible>
                        )
                      })}
                      {additionalDiffs.map((fileDiff) => (
                        <FileDiffView
                          key={fileDiff.name}
                          fileDiff={fileDiff}
                          options={{
                            diffStyle: "unified",
                            themeType: resolvedTheme === "dark" ? "dark" : "light",
                          }}
                        />
                      ))}
                      {!files.length ? (
                        <p className="text-muted-foreground p-6 text-center text-xs">
                          {staged ? "No staged changes" : "All changes are staged"}
                        </p>
                      ) : null}
                    </TabsContent>
                  </Tabs>
                )}
                {staged && stagedFiles.length > 0 ? (
                  <form
                    className="flex shrink-0 items-center gap-2 border-t p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!data.tree) return
                      syncGit({ operation: "commit", head: data.head, tree: data.tree, message })
                    }}
                  >
                    <Field>
                      <FieldLabel htmlFor="commit-message" className="sr-only">
                        Commit message
                      </FieldLabel>
                      <Input
                        id="commit-message"
                        disabled={pending}
                        value={message}
                        maxLength={20_000}
                        onChange={(event) => setMessage(event.target.value)}
                        placeholder="Leave empty to generate a message"
                      />
                    </Field>
                    <Button type="submit" size="sm" disabled={pending || !data.tree}>
                      {pending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <GitCommitHorizontal data-icon="inline-start" />
                      )}
                      Commit
                    </Button>
                  </form>
                ) : null}
              </>
            ) : null}
            {tab === "github" ? (
              <div className="flex flex-col gap-4 p-3">
                {github.error ? (
                  <Alert variant="destructive">
                    <CircleAlert aria-hidden="true" />
                    <AlertDescription>
                      Could not load GitHub. Check your account connection and repository access.
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={github.isFetching}
                        onClick={() => void github.refetch()}
                      >
                        <RefreshCw /> Retry GitHub
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {github.isPending ? (
                  <div role="status" aria-label="Loading GitHub" className="flex flex-col gap-3">
                    <Skeleton className="h-8 w-36" />
                    <Skeleton className="h-40 w-full" />
                  </div>
                ) : null}
                {github.data && githubInfo && data ? (
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
                        <ArrowDown /> Pull
                      </Button>
                      <Button
                        variant="outline"
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
                        <ArrowUp /> {githubInfo.branchHead ? "Push" : "Publish branch"}
                      </Button>
                      {githubInfo.branchHead === data.head ? (
                        <span className="text-muted-foreground ml-auto text-xs">Up to date</span>
                      ) : null}
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
                              startTransition(async () => {
                                try {
                                  const url = await createCodingPullRequest(
                                    workspaceId,
                                    tree.agent_name,
                                    thread.session_id,
                                    prTitle,
                                    prBody,
                                    githubInfo.defaultBranch
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
                            <FieldGroup>
                              <Field>
                                <FieldLabel htmlFor="pr-title">Title</FieldLabel>
                                <Input
                                  id="pr-title"
                                  disabled={pending}
                                  placeholder="Title"
                                  value={prTitle}
                                  onChange={(event) => setPrTitle(event.target.value)}
                                  maxLength={256}
                                />
                              </Field>
                              <Field>
                                <FieldLabel htmlFor="pr-description">Description</FieldLabel>
                                <Textarea
                                  id="pr-description"
                                  disabled={pending}
                                  maxLength={65_536}
                                  placeholder="Describe your changes"
                                  value={prBody}
                                  onChange={(event) => setPrBody(event.target.value)}
                                  className="min-h-24"
                                />
                              </Field>
                            </FieldGroup>
                            <Button
                              variant="outline"
                              type="submit"
                              disabled={pending || !prTitle.trim()}
                            >
                              <GitPullRequest data-icon="inline-start" />
                              Create pull request
                            </Button>
                          </form>
                        </DialogContent>
                      </Dialog>
                    </div>
                    {[
                      {
                        title: "Pull requests",
                        icon: GitPullRequest,
                        color: "text-primary",
                        items: github.data.pages.flatMap((page) => page.pulls),
                        empty: "No open pull requests.",
                      },
                      {
                        title: "Issues",
                        icon: CircleDot,
                        color: "text-info",
                        items: github.data.pages.flatMap((page) => page.issues),
                        empty: "No open issues.",
                      },
                    ].map(({ title, icon: Icon, color, items, empty }) => (
                      <section key={title}>
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                          <Icon className={cn("size-4", color)} aria-hidden="true" />
                          {title}
                          <Badge variant="secondary">{items.length}</Badge>
                        </h3>
                        {items.map((item) => (
                          <a
                            key={item.number}
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:bg-accent focus-visible:ring-ring flex items-center gap-2 rounded-md px-2 py-2 text-sm outline-none focus-visible:ring-2"
                          >
                            <span className="text-muted-foreground">#{item.number}</span>
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                            <ExternalLink
                              className="text-muted-foreground size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          </a>
                        ))}
                        {!items.length ? (
                          <p className="text-muted-foreground text-sm">{empty}</p>
                        ) : null}
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
          </TabsContent>
        ) : null}
      </Tabs>
    </aside>
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
