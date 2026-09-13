"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  queryOptions,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { LegendList } from "@legendapp/list/react"
import { CodeView, WorkerPoolContext, type CodeViewHandle } from "@pierre/diffs/react"
import { DEFAULT_THEMES, type CodeViewDiffItem, type CodeViewScrollTarget } from "@pierre/diffs"
import { WorkerPoolManager } from "@pierre/diffs/worker"
import { useTheme } from "next-themes"
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  MoreHorizontal,
  PanelLeft,
  Settings2,
  ExternalLink,
  FileCode2,
  GitCommitHorizontal,
  GitMerge,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Sparkles,
  TextWrap,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { codingRemoteHead, remoteCodingGit } from "@/lib/coding/actions"
import {
  suggestCodingText,
  type CodingGitComparison,
  type CodingGitRequest,
  type CodingGitResult,
  type CodingGitStash,
  type CodingThread,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"
import { gitQueries, runWorkspaceGit } from "@/lib/coding/review"

type GitChangesProps = {
  thread: CodingThread
  workspaceId: string
  status: UseQueryResult<CodingGitResult>
  visible: boolean
  expanded: boolean
  onExpand: () => void
}

const comparisons = [
  { value: "all", label: "All changes" },
  { value: "unstaged", label: "Unstaged" },
  { value: "staged", label: "Staged" },
] satisfies { value: CodingGitComparison; label: string }[]

function wrapCommitDescription(text: string) {
  return text
    .split("\n")
    .flatMap((line) => {
      const lines: string[] = []
      while (line.length > 80) {
        const space = line.lastIndexOf(" ", 80)
        const end = space > 0 ? space : 80
        lines.push(line.slice(0, end))
        line = line.slice(end + (space > 0 ? 1 : 0))
      }
      lines.push(line)
      return lines
    })
    .join("\n")
}

export function GitChanges({
  thread,
  workspaceId,
  status,
  visible,
  expanded,
  onExpand,
}: GitChangesProps) {
  const queryClient = useQueryClient()
  const { data: actor } = authClient.useSession()
  const mutationKey = ["coding", "git", workspaceId, thread.worktree.id]
  const busy = useIsMutating({ mutationKey }) > 0
  const mobile = useIsMobile()
  const [composerOpen, setComposerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>()
  const showSidebar = !expanded || (sidebarOpen ?? !mobile)
  const { resolvedTheme } = useTheme()
  const { previewFile } = useFileWorkspace()
  const [comparison, setComparison] = useState<CodingGitComparison>("all")
  const [filter, setFilter] = useState("")
  const [selected, setSelected] = useState<string>()
  const [hunk, setHunk] = useState(0)
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [message, setMessage] = useState("")
  const [description, setDescription] = useState("")
  const commitMessage = `${message.trim()}\n\n${description}`.trim()
  const subjectHighlight = useRef<HTMLDivElement>(null)
  const subjectInput = useRef<HTMLInputElement>(null)
  const [stashPicker, setStashPicker] = useState(false)
  const [stashFilter, setStashFilter] = useState("")
  const [stash, setStash] = useState<CodingGitStash>()
  const [stashAction, setStashAction] = useState<
    "stash_create" | "stash_apply" | "stash_pop" | "stash_drop"
  >()
  const [stashMessage, setStashMessage] = useState("")
  const [stashScope, setStashScope] = useState<CodingGitComparison>("all")
  const [restoreIndex, setRestoreIndex] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pool, setPool] = useState<WorkerPoolManager>()
  const [workerError, setWorkerError] = useState<string>()
  const [reviewWidth, setReviewWidth] = useState(0)
  const reviewElement = useRef<HTMLDivElement>(null)
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null)
  const lastRevision = useRef<string>(undefined)
  const pendingReveal = useRef<CodeViewScrollTarget>(undefined)
  const data = status.data
  const branch = data?.branch ?? ""
  const remoteKey = [
    "coding",
    "remote",
    workspaceId,
    thread.worktree.id,
    branch,
    thread.worktree.agent_name,
    thread.session_id,
    actor?.user.id,
  ]
  const remote = useQuery(
    queryOptions({
      queryKey: remoteKey,
      staleTime: 0,
      queryFn: () =>
        codingRemoteHead(workspaceId, thread.worktree.agent_name, thread.session_id, branch),
      enabled: visible && !!branch && !!actor?.user.id && !status.isError && !busy,
    })
  )

  useEffect(() => {
    const manager = new WorkerPoolManager(
      {
        workerFactory: () =>
          new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
            type: "module",
          }),
        poolSize: 2,
        totalASTLRUCacheSize: 12,
      },
      {
        theme: DEFAULT_THEMES,
        langs: ["text"],
        lineDiffType: "word",
        maxLineDiffLength: 1000,
        tokenizeMaxLineLength: 1000,
      }
    )
    let active = true
    void manager
      .initialize()
      .then(() => {
        if (active) setPool(manager)
      })
      .catch((error: Error) => {
        if (active) setWorkerError(error.message)
      })
    return () => {
      active = false
      manager.terminate()
    }
  }, [])

  useEffect(() => {
    const element = reviewElement.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setReviewWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded])

  const queries = gitQueries(
    { thread, workspaceId, visible, expanded },
    comparison,
    stash,
    stashPicker
  )
  const review = useQuery(queries.review)

  useEffect(() => {
    if (!data || stash) return
    if (lastRevision.current !== undefined && lastRevision.current !== data.revision) {
      void queryClient.invalidateQueries({
        queryKey: queries.review.queryKey.slice(0, 4),
      })
    }
    lastRevision.current = data.revision
  }, [data, stash, queryClient, queries.review.queryKey])

  const stashes = useQuery(queries.stashes)
  const filteredStashes = stashes.data?.filter((item) =>
    item.message.toLowerCase().includes(stashFilter.toLowerCase())
  )

  const mutation = useMutation({
    mutationKey,
    mutationFn: (body: CodingGitRequest) => runWorkspaceGit(workspaceId, thread.worktree.id, body),
    onSuccess: (_, body) => {
      if (
        body.operation === "stash_create" ||
        body.operation === "stash_apply" ||
        body.operation === "stash_pop" ||
        body.operation === "stash_drop"
      ) {
        setStashAction(undefined)
        setStashMessage("")
        if (body.operation === "stash_pop" || body.operation === "stash_drop") setStash(undefined)
        toast.success(
          {
            stash_create: "Changes stashed",
            stash_apply: "Stash applied and kept",
            stash_pop: "Stash applied and removed",
            stash_drop: "Stash removed",
          }[body.operation]
        )
      }
    },
    onError: (error) => toast.error(error.message),
    // A failed stash apply can still restore files and leave conflicts.
    onSettled: async () => {
      await Promise.all([
        status.refetch(),
        queryClient.invalidateQueries({ queryKey: queries.stashes.queryKey.slice(0, 5) }),
      ])
    },
  })
  const sync = useMutation({
    mutationKey,
    mutationFn: (body: Parameters<typeof remoteCodingGit>[3]) =>
      remoteCodingGit(workspaceId, thread.worktree.agent_name, thread.session_id, body),
    onSuccess: (_, body) => {
      if (body.operation === "commit") {
        setMessage("")
        setDescription("")
        setComposerOpen(false)
      }
      toast.success(
        { commit: "Staged changes committed", pull: "Pulled", push: "Pushed" }[body.operation]
      )
    },
    onError: (error) => toast.error(error.message),
    onSettled: () =>
      Promise.all([status.refetch(), queryClient.invalidateQueries({ queryKey: remoteKey })]),
  })
  const suggestion = useMutation({
    mutationFn: async () => {
      const response = await suggestCodingText({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: thread.worktree.agent_name, sessionId: thread.session_id },
        body: { purpose: "commit", expected_tree: data?.tree },
      })
      if (response.error) throw new Error(response.error.message)
      return response.data.text
    },
    onSuccess: (text) => {
      const [subject = "", ...body] = text.trim().split(/\r?\n/)
      setMessage(subject)
      setDescription(wrapCommitDescription(body.join("\n").trim()))
    },
    onError: (error) => toast.error(error.message),
  })
  const files = useMemo(
    () =>
      (data?.files ?? [])
        .filter((file) => {
          if (!file.path.toLowerCase().includes(filter.toLowerCase())) return false
          if (file.conflict || comparison === "all") return true
          return comparison === "staged"
            ? file.index !== " " && file.index !== "?"
            : file.worktree !== " "
        })
        .sort((a, b) => (a.conflict === b.conflict ? 0 : a.conflict ? -1 : 1)),
    [data?.files, filter, comparison]
  )
  const stagedFiles =
    data?.files.filter((file) => !file.conflict && file.index !== " " && file.index !== "?") ?? []
  const changes = data?.files.filter((file) => !file.conflict && file.worktree !== " ") ?? []
  const conflicts = data?.files.filter((file) => file.conflict) ?? []
  const parsed = useMemo(() => review.data ?? [], [review.data])
  const selectedDiff = parsed.find((file) => file.path === selected) ?? parsed[0]
  const selectedHunk = selectedDiff?.diff.hunks[Math.min(hunk, selectedDiff.diff.hunks.length - 1)]
  const canStageHunk =
    !stash && comparison !== "all" && selectedDiff?.can_stage_hunks && selectedHunk !== undefined
  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      parsed.map((file) => ({
        type: "diff",
        id: file.path,
        fileDiff: file.diff,
        version: file.version * 2 + (collapsed.has(file.path) ? 1 : 0),
        collapsed: collapsed.has(file.path),
      })),
    [parsed, collapsed]
  )

  function reveal(path: string, index?: number) {
    setSelected(path)
    setHunk(index ?? 0)
    if (mobile) setSidebarOpen(false)
    const file = parsed.find((file) => file.path === path)
    const hunk = index === undefined ? undefined : file?.diff.hunks[index]
    const target: CodeViewScrollTarget = hunk
      ? {
          type: "line",
          id: path,
          lineNumber: hunk.additionCount ? hunk.additionStart : hunk.deletionStart,
          side: hunk.additionCount ? "additions" : "deletions",
          align: "start",
        }
      : { type: "item", id: path, align: "start" }
    if (!expanded || !viewer.current || collapsed.has(path)) {
      pendingReveal.current = target
      setCollapsed((value) => {
        if (!value.has(path)) return value
        const next = new Set(value)
        next.delete(path)
        return next
      })
      if (!expanded) onExpand()
      return
    }
    viewer.current.scrollTo(target)
  }

  useEffect(() => {
    if (!pendingReveal.current || !viewer.current) return
    viewer.current.scrollTo(pendingReveal.current)
    pendingReveal.current = undefined
  }, [pool, items, expanded])

  function stage(operation: "stage" | "unstage", paths: string[], hunkIndex?: number) {
    mutation.mutate({
      operation,
      paths,
      comparison,
      hunk: hunkIndex,
      expected_head: data?.head || undefined,
      revision: hunkIndex === undefined ? data?.revision : selectedDiff?.revision,
    })
  }

  const syncDisabled =
    busy ||
    status.isError ||
    remote.isFetching ||
    !remote.isSuccess ||
    !branch ||
    !data?.head ||
    remote.data === data.head

  if (!data)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {status.isPending ? "Loading repository" : "Could not load repository"}
          </EmptyTitle>
          <EmptyDescription>{status.error?.message}</EmptyDescription>
        </EmptyHeader>
        {status.error ? (
          <Button
            variant="outline"
            size="sm"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCw data-icon="inline-start" /> Retry
          </Button>
        ) : null}
      </Empty>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status.error ? (
        <Alert variant="warning">
          <AlertTitle>Repository refresh failed</AlertTitle>
          <AlertDescription>{status.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {remote.isError && branch ? (
        <Alert variant="warning">
          <AlertTitle>Could not check remote branch</AlertTitle>
          <AlertDescription>{remote.error.message}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || remote.isFetching}
            onClick={() => void remote.refetch()}
          >
            <RefreshCw data-icon="inline-start" /> Retry
          </Button>
        </Alert>
      ) : null}
      {conflicts.length ? (
        <Alert variant="warning">
          <GitMerge />
          <AlertTitle>
            {conflicts.length} conflicted {conflicts.length === 1 ? "file" : "files"}
          </AlertTitle>
          <AlertDescription>
            Edit each conflicted file, then stage it to mark the conflict resolved.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expanded ? "Toggle file sidebar" : "Review changes"}
          aria-pressed={expanded ? showSidebar : undefined}
          onClick={() => (expanded ? setSidebarOpen(!showSidebar) : onExpand())}
        >
          {expanded ? <PanelLeft /> : <Maximize2 />}
        </Button>
        {stash ? (
          <div className="flex min-w-0 items-center gap-2">
            <Archive className="text-muted-foreground size-4 shrink-0" />
            <span className="max-w-48 truncate text-sm" title={stash.message}>
              {stash.message}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close stash review"
              onClick={() => setStash(undefined)}
            >
              <X />
            </Button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {comparisons.find((item) => item.value === comparison)?.label}
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Compare changes</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={comparison}>
                  {comparisons.map((item) => (
                    <DropdownMenuRadioItem
                      key={item.value}
                      value={item.value}
                      onSelect={() => {
                        setComparison(item.value)
                        setSelected(undefined)
                        setHunk(0)
                      }}
                    >
                      {item.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          {expanded ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous hunk"
                disabled={!selectedDiff || (parsed.indexOf(selectedDiff) === 0 && hunk === 0)}
                onClick={() => {
                  if (!selectedDiff) return
                  if (hunk > 0) reveal(selectedDiff.path, hunk - 1)
                  else {
                    const previous = parsed[parsed.indexOf(selectedDiff) - 1]
                    if (previous) reveal(previous.path, Math.max(0, previous.diff.hunks.length - 1))
                  }
                }}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Next hunk"
                disabled={
                  !selectedDiff ||
                  (parsed.indexOf(selectedDiff) === parsed.length - 1 &&
                    hunk + 1 >= selectedDiff.diff.hunks.length)
                }
                onClick={() => {
                  if (!selectedDiff) return
                  if (hunk + 1 < selectedDiff.diff.hunks.length) reveal(selectedDiff.path, hunk + 1)
                  else {
                    const next = parsed[parsed.indexOf(selectedDiff) + 1]
                    if (next) reveal(next.path)
                  }
                }}
              >
                <ArrowDown />
              </Button>
              {canStageHunk ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || review.isFetching}
                  onClick={() => {
                    if (selectedDiff)
                      stage(
                        comparison === "staged" ? "unstage" : "stage",
                        [selectedDiff.path],
                        Math.min(hunk, selectedDiff.diff.hunks.length - 1)
                      )
                  }}
                >
                  {comparison === "staged" ? <Minus /> : <Plus />}
                  {comparison === "staged" ? "Unstage" : "Stage"} hunk
                </Button>
              ) : null}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Diff settings">
                    <Settings2 />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Diff layout</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={split ? "split" : "unified"}>
                      <DropdownMenuRadioItem value="unified" onSelect={() => setSplit(false)}>
                        <Rows3 /> Unified
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="split" onSelect={() => setSplit(true)}>
                        <Columns2 /> Split
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
                      <TextWrap /> Wrap lines
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh changes"
            disabled={busy || status.isFetching || remote.isFetching || review.isFetching}
            onClick={() => {
              void status.refetch()
              if (branch && actor?.user.id) void remote.refetch()
              if (expanded) void review.refetch()
            }}
          >
            {status.isFetching || remote.isFetching || review.isFetching ? (
              <Spinner />
            ) : (
              <RefreshCw />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Git actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => setStashPicker(true)}>
                  <Archive /> Browse stashes
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || changes.length === 0 || changes.length > 1000}
                  onSelect={() =>
                    stage(
                      "stage",
                      changes.map((file) => file.path)
                    )
                  }
                >
                  <Plus /> Stage all changes
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || stagedFiles.length === 0 || stagedFiles.length > 500}
                  onSelect={() =>
                    stage(
                      "unstage",
                      stagedFiles.flatMap((file) =>
                        file.previous_path ? [file.path, file.previous_path] : [file.path]
                      )
                    )
                  }
                >
                  <Minus /> Unstage all changes
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || data.files.length === 0 || conflicts.length > 0}
                  onSelect={() => setStashAction("stash_create")}
                >
                  <Archive /> Stash changes...
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!stash ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              aria-label="Pull"
              disabled={syncDisabled || !remote.data || data.files.length > 0}
              onClick={() => sync.mutate({ operation: "pull", head: data.head })}
            >
              {sync.isPending && sync.variables.operation === "pull" ? <Spinner /> : <ArrowDown />}
              Pull
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={remote.data === "" ? "Publish branch" : "Push"}
              disabled={syncDisabled}
              onClick={() => {
                if (remote.data !== undefined)
                  sync.mutate({ operation: "push", head: data.head, remoteHead: remote.data })
              }}
            >
              {sync.isPending && sync.variables.operation === "push" ? <Spinner /> : <ArrowUp />}
              {remote.data === "" ? "Publish branch" : "Push"}
            </Button>
            <Popover open={composerOpen} onOpenChange={setComposerOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" disabled={busy} aria-label="Commit changes">
                  <GitCommitHorizontal data-icon="inline-start" /> Commit
                  <span className="tabular-nums" aria-label={`${stagedFiles.length} staged`}>
                    {stagedFiles.length}
                  </span>
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                collisionPadding={12}
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  subjectInput.current?.focus()
                }}
                aria-labelledby={`commit-title-${thread.worktree.id}`}
                className="max-h-[min(85svh,var(--radix-popover-content-available-height))] w-[min(35rem,calc(100vw-1.5rem))] gap-0 overflow-hidden p-0"
              >
                <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
                  <h2 id={`commit-title-${thread.worktree.id}`} className="font-medium">
                    Commit changes
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close commit form"
                    onClick={() => setComposerOpen(false)}
                  >
                    <X />
                  </Button>
                </div>
                <form
                  className="flex min-h-0 flex-col"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (data.tree)
                      sync.mutate({
                        operation: "commit",
                        head: data.head,
                        tree: data.tree,
                        message: commitMessage,
                      })
                  }}
                >
                  <FieldGroup className="gap-4 overflow-y-auto p-4">
                    {!data.tree || !data.head || !stagedFiles.length ? (
                      <FieldDescription>
                        {!data.tree
                          ? "Resolve conflicts before committing."
                          : !data.head
                            ? "This repository has no initial commit."
                            : "Stage changes to include them in this commit."}
                      </FieldDescription>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor={`commit-${thread.worktree.id}`}>
                        Commit message
                      </FieldLabel>
                      <div className="relative font-mono text-base md:text-sm">
                        <Input
                          ref={subjectInput}
                          id={`commit-${thread.worktree.id}`}
                          placeholder="Summarize your changes"
                          value={message}
                          onChange={(event) => setMessage(event.target.value)}
                          onScroll={(event) => {
                            if (subjectHighlight.current)
                              subjectHighlight.current.scrollLeft = event.currentTarget.scrollLeft
                          }}
                          required
                          maxLength={20_000}
                          disabled={busy || suggestion.isPending}
                        />
                        <div
                          ref={subjectHighlight}
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-px flex items-center overflow-hidden px-2.5 text-transparent"
                        >
                          <span className="shrink-0 whitespace-pre">
                            {message.slice(0, 50)}
                            <mark className="bg-warning/25 text-transparent">
                              {message.slice(50)}
                            </mark>
                          </span>
                        </div>
                      </div>
                    </Field>
                    <Field data-invalid={commitMessage.length > 20_000}>
                      <FieldLabel htmlFor={`commit-description-${thread.worktree.id}`}>
                        Extended description
                      </FieldLabel>
                      <Textarea
                        id={`commit-description-${thread.worktree.id}`}
                        placeholder="Add an optional extended description…"
                        value={description}
                        onChange={(event) => {
                          const input = event.currentTarget
                          const value = input.value
                          const wrapped = wrapCommitDescription(value)
                          if (wrapped !== value) {
                            const start = wrapCommitDescription(
                              value.slice(0, input.selectionStart)
                            ).length
                            const end = wrapCommitDescription(
                              value.slice(0, input.selectionEnd)
                            ).length
                            input.value = wrapped
                            input.setSelectionRange(start, end)
                          }
                          setDescription(wrapped)
                        }}
                        maxLength={20_000}
                        disabled={busy || suggestion.isPending}
                        aria-invalid={commitMessage.length > 20_000}
                        aria-describedby={
                          commitMessage.length > 20_000
                            ? `commit-error-${thread.worktree.id}`
                            : undefined
                        }
                        className="h-32 min-h-24 resize-y font-mono"
                      />
                      {commitMessage.length > 20_000 ? (
                        <FieldError id={`commit-error-${thread.worktree.id}`}>
                          Keep the message and description within 20,000 characters combined.
                        </FieldError>
                      ) : null}
                    </Field>
                  </FieldGroup>
                  {sync.error && sync.variables?.operation === "commit" ? (
                    <Alert variant="destructive" className="mx-4 mb-4 w-auto">
                      <AlertDescription>{sync.error.message}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex shrink-0 items-center gap-2 border-t p-3">
                    <span className="text-muted-foreground mr-auto text-xs tabular-nums">
                      {stagedFiles.length} staged
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Generate commit message"
                          disabled={busy || suggestion.isPending || !stagedFiles.length}
                          onClick={() => suggestion.mutate()}
                        >
                          {suggestion.isPending ? <Spinner /> : <Sparkles />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Generate commit message</TooltipContent>
                    </Tooltip>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setComposerOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        busy ||
                        suggestion.isPending ||
                        !message.trim() ||
                        commitMessage.length > 20_000 ||
                        !data.tree ||
                        !data.head ||
                        !stagedFiles.length
                      }
                    >
                      {sync.isPending && sync.variables.operation === "commit" ? (
                        <Spinner />
                      ) : (
                        <GitCommitHorizontal />
                      )}{" "}
                      Commit staged
                    </Button>
                  </div>
                </form>
              </PopoverContent>
            </Popover>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-col",
            expanded
              ? "w-64 shrink-0 border-r max-md:w-full max-md:border-r-0 max-md:border-b"
              : "flex-1",
            expanded && "max-md:h-56",
            !showSidebar && "hidden"
          )}
        >
          <div className="relative m-3">
            <Search className="text-muted-foreground pointer-events-none absolute top-2 left-2 size-4" />
            <Input
              aria-label="Filter changed files"
              placeholder="Filter files..."
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="pl-8"
            />
          </div>
          <div className="min-h-0 flex-1">
            {stash ? (
              <LegendList
                data={parsed.filter((file) =>
                  file.path.toLowerCase().includes(filter.toLowerCase())
                )}
                keyExtractor={(file) => file.path}
                estimatedItemSize={32}
                style={{ height: "100%" }}
                renderItem={({ item }) => (
                  <Button
                    variant="ghost"
                    className={cn(
                      "h-8 w-full justify-start rounded-none px-3",
                      selectedDiff?.path === item.path && "bg-accent"
                    )}
                    onClick={() => reveal(item.path)}
                    title={item.path}
                  >
                    <FileCode2 className="text-muted-foreground" />
                    <span className="truncate">{item.path}</span>
                  </Button>
                )}
              />
            ) : files.length ? (
              <LegendList
                data={files}
                extraData={{ selected: selectedDiff?.path, collapsed, expanded, busy, parsed }}
                keyExtractor={(file) => file.path}
                estimatedItemSize={32}
                style={{ height: "100%" }}
                renderItem={({ item: file }) => {
                  const staged = !file.conflict && file.index !== " " && file.index !== "?"
                  return (
                    <div
                      className={cn(
                        "group flex h-8 items-center gap-2 px-3",
                        selectedDiff?.path === file.path ? "bg-accent" : "hover:bg-muted/50"
                      )}
                    >
                      <Checkbox
                        aria-label={`${staged && (comparison === "staged" || file.worktree === " ") ? "Unstage" : "Stage"} ${file.path}`}
                        disabled={busy}
                        checked={staged ? (file.worktree !== " " ? "indeterminate" : true) : false}
                        onCheckedChange={() => {
                          const operation =
                            staged && (comparison === "staged" || file.worktree === " ")
                              ? "unstage"
                              : "stage"
                          stage(
                            operation,
                            operation === "unstage" && file.previous_path
                              ? [file.path, file.previous_path]
                              : [file.path]
                          )
                        }}
                      />
                      <button
                        className="focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-2 self-stretch text-left text-sm"
                        title={
                          file.previous_path ? `${file.previous_path} → ${file.path}` : file.path
                        }
                        onClick={() => {
                          if (file.conflict)
                            previewFile(thread.worktree.agent_name, {
                              name: file.path.split("/").at(-1) ?? file.path,
                              path: `${thread.worktree.directory.slice("/home/agentz/".length)}/${file.path}`,
                            })
                          else {
                            setStash(undefined)
                            reveal(file.path)
                          }
                        }}
                      >
                        {file.conflict ? (
                          <GitMerge className="text-warning size-3.5 shrink-0" />
                        ) : (
                          <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
                        )}
                        <span className="truncate">{file.path}</span>
                        <span
                          className={cn(
                            "ml-auto font-mono text-xs",
                            file.conflict
                              ? "text-warning"
                              : file.index === "?" || file.index === "A"
                                ? "text-success"
                                : "text-muted-foreground"
                          )}
                        >
                          {file.conflict
                            ? "!"
                            : file.index === "?"
                              ? "U"
                              : file.worktree.trim() || file.index}
                        </span>
                      </button>
                    </div>
                  )
                }}
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Check />
                  </EmptyMedia>
                  <EmptyTitle>{filter ? "No matching files" : "No changes"}</EmptyTitle>
                  <EmptyDescription>
                    {filter
                      ? "Try another filename."
                      : "Changes made by you or the agent appear here."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
        {expanded ? (
          <div
            ref={reviewElement}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            aria-label="Git review"
          >
            {stash ? (
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className="text-muted-foreground flex-1 text-xs">
                  Saved {new Date(stash.created_at).toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStashAction("stash_apply")}
                >
                  <ArchiveRestore /> Apply
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStashAction("stash_pop")}
                >
                  Pop
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Drop stash"
                  disabled={busy}
                  onClick={() => setStashAction("stash_drop")}
                >
                  <Trash2 />
                </Button>
              </div>
            ) : null}
            {review.error || workerError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load comparison</AlertTitle>
                <AlertDescription>{review.error?.message ?? workerError}</AlertDescription>
                {review.error ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={review.isFetching}
                    onClick={() => void review.refetch()}
                  >
                    <RefreshCw data-icon="inline-start" /> Retry
                  </Button>
                ) : null}
              </Alert>
            ) : null}
            {pool && parsed.length ? (
              <WorkerPoolContext.Provider value={pool}>
                <CodeView
                  ref={viewer}
                  items={items}
                  className="git-review min-h-0 flex-1 overflow-auto px-3"
                  options={{
                    theme: DEFAULT_THEMES,
                    themeType: resolvedTheme === "dark" ? "dark" : "light",
                    diffStyle: split && reviewWidth >= 800 ? "split" : "unified",
                    overflow: wrap ? "wrap" : "scroll",
                    tokenizeMaxLength: 10_000,
                    tokenizeMaxLineLength: 1000,
                    lineDiffType: "word",
                    stickyHeaders: true,
                    layout: { paddingTop: 12, paddingBottom: 12, gap: 16 },
                    itemMetrics: { diffHeaderHeight: 44 },
                    diffIndicators: "classic",
                    hunkSeparators: "metadata",
                    enableLineSelection: true,
                    onLineClick: (line, context) => {
                      if (context.type !== "diff" || line.type !== "diff-line") return
                      setSelected(context.item.id)
                      const index = context.item.fileDiff.hunks.findIndex((hunk) => {
                        const start =
                          line.annotationSide === "deletions"
                            ? hunk.deletionStart
                            : hunk.additionStart
                        const count =
                          line.annotationSide === "deletions"
                            ? hunk.deletionCount
                            : hunk.additionCount
                        return line.lineNumber >= start && line.lineNumber < start + count
                      })
                      if (index >= 0) setHunk(index)
                    },
                  }}
                  renderCustomHeader={(item) => (
                    <div className="bg-muted flex h-11 items-center gap-2 rounded-t-lg border px-3 text-sm">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`${collapsed.has(item.id) ? "Expand" : "Collapse"} ${item.id}`}
                        onClick={() =>
                          setCollapsed((value) => {
                            const next = new Set(value)
                            if (next.has(item.id)) next.delete(item.id)
                            else next.add(item.id)
                            return next
                          })
                        }
                      >
                        {collapsed.has(item.id) ? <ChevronRight /> : <ChevronDown />}
                      </Button>
                      <button
                        className="min-w-0 flex-1 truncate text-left font-mono"
                        title={item.id}
                        onClick={() => reveal(item.id)}
                      >
                        {item.id}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Copy path ${item.id}`}
                        onClick={() =>
                          void navigator.clipboard.writeText(item.id).then(
                            () => toast.success("File path copied"),
                            () => toast.error("Could not copy file path")
                          )
                        }
                      >
                        <Copy />
                      </Button>
                      {item.type === "diff" && !item.fileDiff.hunks.length ? (
                        <span className="text-muted-foreground text-xs">
                          {parsed.find((file) => file.path === item.id)?.binary
                            ? "Binary file"
                            : item.fileDiff.type === "rename-pure"
                              ? "Renamed"
                              : item.fileDiff.prevMode
                                ? `${item.fileDiff.prevMode} → ${item.fileDiff.mode}`
                                : "Empty file"}
                        </span>
                      ) : item.type === "diff" ? (
                        <span className="text-muted-foreground text-xs tabular-nums">
                          <span className="text-success">
                            +
                            {item.fileDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0)}
                          </span>{" "}
                          <span className="text-destructive">
                            −
                            {item.fileDiff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0)}
                          </span>
                        </span>
                      ) : null}
                      {!stash && item.type === "diff" && item.fileDiff.type !== "deleted" ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Open ${item.id}`}
                          onClick={() =>
                            previewFile(thread.worktree.agent_name, {
                              name: item.id.split("/").at(-1) ?? item.id,
                              path: `${thread.worktree.directory.slice("/home/agentz/".length)}/${item.id}`,
                            })
                          }
                        >
                          <ExternalLink />
                        </Button>
                      ) : null}
                    </div>
                  )}
                />
              </WorkerPoolContext.Provider>
            ) : !review.error && !workerError ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {review.isPending || (!pool && !workerError) ? <Spinner /> : <Check />}
                  </EmptyMedia>
                  <EmptyTitle>
                    {review.isPending || (!pool && !workerError)
                      ? "Preparing review"
                      : "No changes in this comparison"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {review.isPending
                      ? "The file list stays available while changes load."
                      : "Select another comparison or continue in the workspace."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog open={stashPicker} onOpenChange={setStashPicker}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Stashes</DialogTitle>
            <DialogDescription>
              Saved changes shared by this repository&apos;s worktrees.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Filter stashes"
            placeholder="Filter saved changes..."
            value={stashFilter}
            onChange={(event) => setStashFilter(event.target.value)}
          />
          {stashes.error ? (
            <Alert variant="destructive">
              <AlertDescription>{stashes.error.message}</AlertDescription>
              <Button variant="outline" size="sm" onClick={() => void stashes.refetch()}>
                Retry
              </Button>
            </Alert>
          ) : null}
          {stashes.isPending ? (
            <Spinner />
          ) : filteredStashes?.length ? (
            <div className="h-80 min-w-0">
              <LegendList
                data={filteredStashes}
                keyExtractor={(stash) => stash.oid}
                estimatedItemSize={64}
                style={{ height: "100%" }}
                renderItem={({ item }) => (
                  <Button
                    variant="ghost"
                    className="h-16 w-full justify-start"
                    onClick={() => {
                      setStash(item)
                      setStashPicker(false)
                      setSelected(undefined)
                      onExpand()
                    }}
                  >
                    <Archive />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="w-full truncate text-left">{item.message}</span>
                      <span className="text-muted-foreground text-xs" title={item.created_at}>
                        {item.reference} · {new Date(item.created_at).toLocaleString()}
                      </span>
                    </span>
                    <ChevronRight />
                  </Button>
                )}
              />
            </div>
          ) : !stashes.error ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{stashFilter ? "No matching stashes" : "No saved changes"}</EmptyTitle>
                <EmptyDescription>
                  {stashFilter
                    ? "Try another search or clear the filter."
                    : "Stash your changes to return to them later."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!data.files.length || conflicts.length > 0}
              onClick={() => {
                setStashPicker(false)
                setStashAction("stash_create")
              }}
            >
              <Plus /> Stash changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={stashAction !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setStashAction(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {stashAction === "stash_create"
                ? "Stash changes"
                : stashAction === "stash_drop"
                  ? "Drop saved changes?"
                  : stashAction === "stash_pop"
                    ? "Apply and remove stash?"
                    : "Apply saved changes"}
            </DialogTitle>
            <DialogDescription>
              {stashAction === "stash_create"
                ? "Save local changes before moving on to another task."
                : stashAction === "stash_drop"
                  ? "This removes the saved entry without applying it. This action cannot be undone here."
                  : `Restore into ${data.branch || thread.worktree.branch}. ${stashAction === "stash_pop" ? "The entry is removed only after a successful apply." : "The saved entry will be kept."}`}
            </DialogDescription>
          </DialogHeader>
          {stashAction === "stash_create" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="stash-message">Message</FieldLabel>
                <Input
                  id="stash-message"
                  placeholder="What are you setting aside?"
                  value={stashMessage}
                  onChange={(event) => setStashMessage(event.target.value)}
                  maxLength={1000}
                />
              </Field>
              <Field>
                <FieldLabel>Changes to save</FieldLabel>
                <Tabs
                  value={stashScope}
                  onValueChange={(value) => {
                    const choice = comparisons.find((item) => item.value === value)
                    if (choice) setStashScope(choice.value)
                  }}
                >
                  <TabsList>
                    {comparisons.map((item) => (
                      <TabsTrigger key={item.value} value={item.value}>
                        {item.value === "unstaged" ? "Tracked" : item.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <FieldDescription>
                  {stashScope === "all"
                    ? "Includes untracked files. Ignored files stay in place."
                    : stashScope === "staged"
                      ? "Saves only staged content, leaving unstaged edits in place."
                      : "Saves tracked changes, including newly staged files."}
                </FieldDescription>
              </Field>
            </FieldGroup>
          ) : (
            <>
              <p className="truncate font-mono text-sm" title={stash?.message}>
                {stash?.message}
              </p>
              {stashAction !== "stash_drop" ? (
                <Field orientation="horizontal">
                  <Checkbox
                    id="restore-index"
                    checked={restoreIndex}
                    onCheckedChange={(value) => setRestoreIndex(value === true)}
                  />
                  <FieldLabel htmlFor="restore-index">Restore staging</FieldLabel>
                </Field>
              ) : null}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setStashAction(undefined)}>
              Cancel
            </Button>
            <Button
              variant={stashAction === "stash_drop" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => {
                if (stashAction)
                  mutation.mutate({
                    operation: stashAction,
                    comparison: stashScope,
                    revision: data.revision,
                    stash: stash?.oid,
                    message: stashMessage || undefined,
                    restore_index: restoreIndex,
                  })
              }}
            >
              {busy ? <Spinner /> : stashAction === "stash_drop" ? <Trash2 /> : <ArchiveRestore />}
              {stashAction === "stash_create"
                ? "Stash changes"
                : stashAction === "stash_drop"
                  ? "Drop stash"
                  : stashAction === "stash_pop"
                    ? "Apply and remove"
                    : "Apply and keep"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
