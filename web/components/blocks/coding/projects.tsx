"use client"

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "@bprogress/next/app"
import Link from "next/link"
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { useSearchParams } from "next/navigation"
import { infiniteQueryOptions, useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  ChevronDown,
  RefreshCw,
  FolderGit2,
  GitBranch,
  Lock,
  Plus,
  Trash2,
} from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import {
  AdministrationPageHeader,
  AdministrationState,
  type AdministrationPageScope,
} from "@/components/administration"
import { ProjectTable } from "./project-table"
import { codingDrafts, useCodingDrafts } from "./drafts"
import type {
  CodingProject,
  CodingProjectDetail,
  CodingWorktree,
  CodingRepositoryItem,
} from "@/lib/gateway/client"
import {
  deleteCodingProject,
  getCodingProject,
  renameCodingProject,
  runCodingGit,
  listCodingRepositories,
  createCodingProject,
  listCodingRefs,
  adoptCodingWorktree,
  refreshCodingRepository,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

export function ProjectPicker({
  projects,
  workspacePath,
  open = true,
  onOpenChange,
  onSelect,
}: {
  projects: CodingProject[]
  workspacePath: `/orgs/${string}/workspaces/${string}`
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSelect?: (project: CodingProject) => void
}) {
  const router = useRouter()
  const search = useSearchParams()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (onOpenChange) {
          onOpenChange(next)
          return
        }
        if (!next) router.replace(`${workspacePath}/projects`)
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>New chat in...</DialogTitle>
          <DialogDescription>Choose a project for your new chat.</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="New chat in..." />
          <CommandList className="p-2">
            <CommandEmpty>No projects found.</CommandEmpty>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.repository}`}
                onSelect={() => {
                  if (onSelect) {
                    onSelect(project)
                    return
                  }
                  const next = new URLSearchParams({ project: project.id })
                  const agent = search.get("agent")
                  if (agent) next.set("agent", agent)
                  router.replace(`${workspacePath}/sessions/new?${next}`)
                }}
              >
                <FolderGit2 />
                <span className="flex-1 truncate">{project.name}</span>
                <span className="text-muted-foreground truncate text-xs">{project.repository}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export type ProjectActions = {
  add: () => void
  manage: (project: CodingProject, action: "settings" | "rename" | "delete") => void
}

export function Projects({
  projects,
  agentNames,
  workspaceId,
  workspacePath,
  pageScope,
  children,
}: {
  projects: CodingProject[]
  agentNames: string[]
  workspaceId: string
  workspacePath: `/orgs/${string}/workspaces/${string}`
  pageScope?: AdministrationPageScope
  children?: (actions: ProjectActions) => ReactNode
}) {
  const { data: actor } = authClient.useSession()
  const draftScope = actor ? `${actor.user.id}:${workspaceId}` : ""
  const drafts = useCodingDrafts(draftScope)
  const router = useRouter()
  const queryClient = useQueryClient()
  const search = useSearchParams()
  const [creatingProject, setAdding] = useState(false)
  const adding = creatingProject || (!children && search.get("new") === "true")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [targetProject, setTargetProject] = useState<CodingProject>()
  const [settings, setSettings] = useState<CodingProjectDetail>()
  const [editingName, setEditingName] = useState("")
  const [dialog, setDialog] = useState<
    { action: "rename" | "delete" } | { action: "remove"; tree: CodingWorktree }
  >()
  const [name, setName] = useState("")
  const [repository, setRepository] = useState<CodingRepositoryItem>()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [repositorySearch, setRepositorySearch] = useState("")
  const [repositoryQuery, setRepositoryQuery] = useState("")
  const [pending, startTransition] = useTransition()
  useEffect(() => {
    const timer = setTimeout(() => setRepositoryQuery(repositorySearch.trim()), 300)
    return () => clearTimeout(timer)
  }, [repositorySearch])
  const repositories = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: ["coding", "repositories", workspaceId, actor?.user.id, repositoryQuery],
      queryFn: async ({ pageParam, signal }) => {
        const result = await listCodingRepositories({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          query: { query: repositoryQuery, page: pageParam },
          signal,
        })
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      initialPageParam: 1,
      getNextPageParam: (lastPage) => lastPage.next_page,
      enabled: adding && repositoryOpen && Boolean(actor),
      staleTime: 60_000,
      retry: false,
    })
  )
  const searching = repositorySearch.trim() !== repositoryQuery || repositories.isPending
  const onProjectAction = useCallback(
    (item: CodingProject, action: "settings" | "rename" | "delete") => {
      setTargetProject(item)
      if (action === "rename") {
        setEditingName(item.name)
        setDialog({ action: "rename" })
        return
      }
      if (action === "delete") {
        setDialog({ action: "delete" })
        return
      }
      startTransition(async () => {
        try {
          const result = await getCodingProject({
            baseUrl: await getGatewayBaseURL(),
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: { projectId: item.id },
          })
          if (result.error) throw new Error(result.error.message)
          setSettings(result.data)
          setSettingsOpen(true)
        } catch {
          toast.error("Could not load project settings")
        }
      })
    },
    [setDialog, setEditingName, setSettingsOpen, startTransition, workspaceId]
  )

  return (
    <>
      {children ? (
        children({ add: () => setAdding(true), manage: onProjectAction })
      ) : (
        <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
          {pageScope ? (
            <AdministrationPageHeader
              title="Projects"
              scope={pageScope}
              actions={
                <Button disabled={!agentNames.length} onClick={() => setAdding(true)}>
                  <Plus data-icon="inline-start" /> New project
                </Button>
              }
            />
          ) : null}
          <ProjectTable
            projects={projects}
            rowHref={(item) => `?project=${item.id}`}
            pending={pending}
            onProjectAction={onProjectAction}
            emptyState={
              <AdministrationState
                kind="welcome"
                title="No projects yet"
                description={
                  agentNames.length
                    ? "Connect a GitHub repository to start working with an agent."
                    : "Create an agent or ask someone to share one with you before adding a project."
                }
                actions={
                  agentNames.length ? (
                    <Button onClick={() => setAdding(true)}>
                      <Plus data-icon="inline-start" />
                      Add your first project
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </main>
      )}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="flex flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription className="break-all">{targetProject?.repository}</DialogDescription>
          </DialogHeader>
          {settings ? (
            <>
              <section>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <GitBranch className="text-primary size-4" aria-hidden="true" />
                  Checkouts<Badge variant="secondary">{settings.worktrees.length}</Badge>
                </h3>
                <div className="flex flex-col gap-2">
                  {settings.worktrees.map((tree) => (
                    <div
                      key={tree.id}
                      className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={tree.branch}>
                          {tree.branch}
                        </p>
                        <p className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                          <span className="truncate">{tree.agent_name}</span>
                          <Badge variant={tree.ready ? "successPlain" : "plain"}>
                            {tree.ready ? "Ready" : "Preparing"}
                          </Badge>
                        </p>
                        <p
                          className="text-muted-foreground mt-1 truncate font-mono text-xs"
                          title={tree.directory}
                        >
                          {tree.directory}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={`Remove checkout ${tree.branch}`}
                        title="Remove checkout"
                        disabled={pending}
                        onClick={() => {
                          setSettingsOpen(false)
                          setDialog({ action: "remove", tree })
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {!settings.worktrees.length ? (
                    <Empty className="border">
                      <EmptyHeader>
                        <EmptyTitle>No checkouts yet</EmptyTitle>
                        <EmptyDescription>
                          Starting a thread creates a checkout on the selected agent.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : null}
                </div>
              </section>
              {settings.worktrees.length ? (
                <p className="text-muted-foreground text-xs">
                  Remove all checkouts before deleting this project.
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="ghost"
                  disabled={pending || settings.worktrees.length > 0}
                  onClick={() => {
                    setSettingsOpen(false)
                    setDialog({ action: "delete" })
                  }}
                >
                  <Trash2 data-icon="inline-start" />
                  Delete project
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (pending) return
          setAdding(open)
          if (!open && search.get("new") === "true") router.replace(`${workspacePath}/projects`)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a GitHub project</DialogTitle>
            <DialogDescription>Projects and their chats are private to you.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!repository) return
              startTransition(async () => {
                try {
                  const result = await createCodingProject({
                    baseUrl: await getGatewayBaseURL(),
                    headers: { "X-AgentZ-Workspace-ID": workspaceId },
                    body: {
                      name: name.trim() || repository.name.slice(0, 80),
                      repository_id: repository.id,
                    },
                  })
                  if (result.error) throw new Error(result.error.message)
                  const created = result.data
                  await queryClient.invalidateQueries({
                    predicate: (query) =>
                      query.queryKey[0] === "chatSessions" && query.queryKey[1] === workspaceId,
                  })
                  setAdding(false)
                  setName("")
                  setRepository(undefined)
                  router.push(
                    `${workspacePath}/sessions/new?${new URLSearchParams({ project: created.id })}`
                  )
                } catch {
                  toast.error(
                    "Could not create the project. Check your GitHub connection and repository access."
                  )
                }
              })
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="project-repository">Repository</FieldLabel>
                <Popover open={repositoryOpen} onOpenChange={setRepositoryOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="project-repository"
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={repositoryOpen}
                      disabled={pending}
                      className="w-full justify-between"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {repository?.private ? (
                          <Lock aria-label="Private repository" />
                        ) : (
                          <FolderGit2 aria-hidden="true" />
                        )}
                        <span className="truncate">
                          {repository?.name ?? "Select a repository"}
                        </span>
                      </span>
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
                    <Command label="Search repositories" shouldFilter={false}>
                      <CommandInput
                        placeholder="Search GitHub repositories..."
                        value={repositorySearch}
                        onValueChange={setRepositorySearch}
                        maxLength={256}
                      />
                      <CommandList
                        onScroll={(event) => {
                          const list = event.currentTarget
                          if (
                            list.scrollHeight - list.scrollTop - list.clientHeight <
                              list.clientHeight * 2 &&
                            repositories.hasNextPage &&
                            !repositories.isFetching
                          ) {
                            void repositories.fetchNextPage()
                          }
                        }}
                      >
                        {searching ? (
                          <div
                            role="status"
                            className="text-muted-foreground flex items-center justify-center gap-2 p-4 text-sm"
                          >
                            <Spinner />
                            Searching repositories...
                          </div>
                        ) : repositories.error && !repositories.data ? (
                          <div className="p-2">
                            <Alert variant="destructive">
                              <CircleAlert aria-hidden="true" />
                              <AlertDescription>
                                Could not load repositories.{" "}
                                <Link href="/settings/account" className="underline">
                                  Check your GitHub connection
                                </Link>
                                .
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void repositories.refetch()}
                                >
                                  Retry
                                </Button>
                              </AlertDescription>
                            </Alert>
                          </div>
                        ) : (
                          <>
                            <CommandEmpty>
                              No writable repositories found. Grant the Coding GitHub App repository
                              access and write permissions in{" "}
                              <a
                                href="https://github.com/settings/installations"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                              >
                                GitHub installation settings
                              </a>
                              .
                            </CommandEmpty>
                            <CommandGroup>
                              {repositories.data?.pages
                                .flatMap((page) => page.repositories)
                                .map((item) => (
                                  <CommandItem
                                    key={item.id}
                                    value={item.name}
                                    data-checked={repository?.id === item.id}
                                    onSelect={() => {
                                      setRepository(item)
                                      setRepositoryOpen(false)
                                    }}
                                  >
                                    {item.private ? (
                                      <Lock aria-label="Private repository" />
                                    ) : (
                                      <FolderGit2 aria-hidden="true" />
                                    )}
                                    <span className="truncate">{item.name}</span>
                                  </CommandItem>
                                ))}
                            </CommandGroup>
                          </>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </Field>
              <Field>
                <FieldLabel htmlFor="project-name">Project name</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={repository?.name || "owner/repository"}
                  maxLength={80}
                />
                <FieldDescription>Leave blank to use the repository name.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending} type="button">
                  Cancel
                </Button>
              </DialogClose>
              <Button disabled={pending || !repository} type="submit">
                {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                Add project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === "rename"
                ? "Rename project"
                : dialog?.action === "remove"
                  ? "Remove checkout"
                  : "Delete project"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === "rename"
                ? "Choose a name for this project."
                : dialog?.action === "remove"
                  ? "This removes the checkout and its threads. Close terminals, stop running tasks, and push your commits first."
                  : "This permanently deletes the project."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!dialog || !targetProject) return
              startTransition(async () => {
                try {
                  const options = {
                    baseUrl: await getGatewayBaseURL(),
                    headers: { "X-AgentZ-Workspace-ID": workspaceId },
                  }
                  if (dialog.action === "remove") {
                    const result = await runCodingGit({
                      ...options,
                      path: { worktreeId: dialog.tree.id },
                      body: { operation: "remove" },
                    })
                    if (result.error) throw new Error(result.error.message)
                  } else {
                    const result =
                      dialog.action === "rename"
                        ? await renameCodingProject({
                            ...options,
                            path: { projectId: targetProject.id },
                            body: { name: editingName.trim() },
                          })
                        : await deleteCodingProject({
                            ...options,
                            path: { projectId: targetProject.id },
                          })
                    if (result.error) throw new Error(result.error.message)
                  }
                  await queryClient.invalidateQueries({
                    predicate: (query) =>
                      query.queryKey[0] === "chatSessions" &&
                      query.queryKey[1] === workspaceId &&
                      (dialog.action !== "delete" || query.queryKey[2] !== "group"),
                  })
                  if (dialog.action === "delete") {
                    for (const draft of drafts) {
                      if (draft.projectId === targetProject.id)
                        codingDrafts.remove(draftScope, draft.id)
                    }
                  }
                  if (dialog.action === "delete" && search.get("project") === targetProject.id) {
                    router.replace(`${workspacePath}/projects`)
                  } else {
                    router.refresh()
                  }
                  setDialog(undefined)
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not update project")
                }
              })
            }}
          >
            {dialog?.action === "rename" ? (
              <Field>
                <FieldLabel htmlFor="rename-project">Project name</FieldLabel>
                <Input
                  id="rename-project"
                  autoFocus
                  required
                  maxLength={80}
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                />
              </Field>
            ) : null}
            {dialog?.action === "remove" ? (
              <p className="mb-4 truncate font-mono text-sm">{dialog.tree.branch}</p>
            ) : null}
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setDialog(undefined)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending || (dialog?.action === "rename" && !editingName.trim())}
                variant={dialog?.action === "rename" ? "default" : "destructive"}
              >
                {pending
                  ? "Working..."
                  : dialog?.action === "rename"
                    ? "Save name"
                    : dialog?.action === "remove"
                      ? "Remove checkout"
                      : "Delete project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function CheckoutPicker({
  project,
  agentName,
  workspaceId,
  checkout,
  baseRef,
  disabled,
  onChange,
}: {
  project: CodingProject
  agentName: string
  workspaceId: string
  checkout: string
  baseRef: string | undefined
  disabled: boolean
  onChange: (checkout: string, baseRef?: string) => void
}) {
  const { data: actor } = authClient.useSession()
  const queryClient = useQueryClient()
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [highlight, setHighlight] = useState("")
  const list = useRef<LegendListRef>(null)
  const [pending, startTransition] = useTransition()
  const queryKey = ["coding", "refs", workspaceId, project.id, agentName, actor?.user.id, search]
  const refs = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey,
      initialPageParam: "",
      queryFn: async ({ pageParam, signal, client, queryKey }) => {
        const result = await listCodingRefs({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: { projectId: project.id },
          query: { agent_name: agentName, query: search, cursor: pageParam || undefined },
          signal,
        })
        if (result.error?.code === "snapshot_changed") {
          void client.resetQueries({ queryKey })
        }
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      getNextPageParam: (page) => page.next_cursor,
      enabled: !!actor?.user.id,
      refetchInterval: 30_000,
      retry: false,
    })
  )
  const snapshot = refs.data?.pages[0]
  const branches = refs.data?.pages.flatMap((page) => page.refs) ?? []
  const worktrees = snapshot?.worktrees ?? []
  const items = [
    ...(snapshot?.updated_at &&
    !snapshot.error &&
    !worktrees.some((tree) => tree.directory.endsWith("/repo")) &&
    `main checkout ${project.default_branch}`.toLowerCase().includes(search.toLowerCase())
      ? [{ kind: "main" as const, key: "main" }]
      : []),
    ...worktrees
      .filter((tree) =>
        `${tree.branch} ${tree.directory}`.toLowerCase().includes(search.toLowerCase())
      )
      .map((tree) => ({ kind: "worktree" as const, key: tree.directory, tree })),
    ...branches.map((branch) => ({ kind: "branch" as const, key: branch.ref, branch })),
  ]
  const selected = worktrees.find((tree) => tree.managed_id === checkout)
  const label =
    checkout === "new"
      ? `New worktree · ${baseRef?.replace(/^refs\/(heads|remotes)\//, "") ?? project.default_branch}`
      : checkout === "main"
        ? "Main checkout"
        : selected?.branch || "Detached worktree"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-label="Branch and worktree"
          aria-expanded={open}
          disabled={disabled || pending}
          className="h-7 max-w-80 min-w-0 justify-start px-1.5 text-xs"
        >
          {pending ? <Spinner /> : <GitBranch />}
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-auto" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <Command
          shouldFilter={false}
          value={highlight}
          onValueChange={setHighlight}
          onKeyDownCapture={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            if (!items.length) return
            event.preventDefault()
            event.stopPropagation()
            const step = event.key === "ArrowDown" ? 1 : -1
            let index = items.findIndex((item) => item.key === highlight)
            for (let count = 0; count < items.length; count++) {
              index = (index + step + items.length) % items.length
              const item = items[index]
              if (!item) return
              if (item.kind === "worktree" && !item.tree.available) continue
              setHighlight(item.key)
              void list.current?.scrollIndexIntoView({ index, animated: false })
              break
            }
          }}
        >
          <CommandInput
            placeholder="Find a branch or worktree..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-none overflow-hidden">
            <LegendList
              ref={list}
              data={items}
              estimatedItemSize={32}
              style={{ height: Math.min(items.length * 32 + 48, 280) }}
              keyExtractor={(item) => item.key}
              recycleItems={false}
              onEndReached={() => {
                if (refs.hasNextPage && !refs.isFetching) void refs.fetchNextPage()
              }}
              onEndReachedThreshold={2}
              renderItem={({ item, index }) => (
                <>
                  {index === 0 ||
                  (item.kind === "branch" && items[index - 1]?.kind !== "branch") ? (
                    <div className="text-muted-foreground px-2 py-1.5 text-[11px]">
                      {item.kind === "branch" ? "New worktree from" : "Worktrees"}
                    </div>
                  ) : null}
                  {item.kind === "main" ? (
                    <CommandItem
                      value={item.key}
                      className="data-[checked=true]:bg-muted h-8 text-xs"
                      data-checked={checkout === "main"}
                      onSelect={() => {
                        onChange("main")
                        setOpen(false)
                      }}
                    >
                      <FolderGit2 className="text-muted-foreground size-3.5" />
                      <span className="flex-1">Main checkout</span>
                      <span className="text-muted-foreground/60 text-[10px]">
                        {project.default_branch}
                      </span>
                    </CommandItem>
                  ) : item.kind === "branch" ? (
                    <CommandItem
                      value={item.key}
                      className="data-[checked=true]:bg-muted h-8 text-xs"
                      data-checked={
                        checkout === "new" &&
                        (baseRef ?? `refs/heads/${project.default_branch}`) === item.branch.ref
                      }
                      title={item.branch.ref}
                      onSelect={() => {
                        onChange("new", item.branch.ref)
                        setOpen(false)
                      }}
                    >
                      <GitBranch className="text-muted-foreground size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{item.branch.name}</span>
                      <span className="text-muted-foreground/60 text-[10px]">
                        {item.branch.current
                          ? "current"
                          : item.branch.remote
                            ? "remote"
                            : item.branch.default
                              ? "default"
                              : ""}
                      </span>
                    </CommandItem>
                  ) : (
                    <CommandItem
                      value={item.key}
                      className="data-[checked=true]:bg-muted h-8 text-xs"
                      disabled={!item.tree.available || pending}
                      data-checked={checkout === item.tree.managed_id}
                      title={item.tree.reason ?? item.tree.directory}
                      onSelect={() => {
                        if (item.tree.managed_id) {
                          onChange(item.tree.managed_id)
                          setOpen(false)
                          return
                        }
                        startTransition(async () => {
                          const result = await adoptCodingWorktree({
                            baseUrl: await getGatewayBaseURL(),
                            headers: { "X-AgentZ-Workspace-ID": workspaceId },
                            path: { projectId: project.id },
                            body: { agent_name: agentName, directory: item.tree.directory },
                          })
                          if (result.error) {
                            toast.error(result.error.message)
                            return
                          }
                          if (!active.current) return
                          onChange(result.data.id)
                          setOpen(false)
                          await queryClient.invalidateQueries({ queryKey: queryKey.slice(0, 5) })
                        })
                      }}
                    >
                      <FolderGit2 className="text-muted-foreground size-3.5" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.tree.branch || item.tree.directory.split("/").at(-1)}
                      </span>
                      {item.tree.locked ? <Lock className="text-muted-foreground size-3" /> : null}
                      <span className="text-muted-foreground/60 text-[10px]">
                        {!item.tree.available
                          ? "unavailable"
                          : !item.tree.branch
                            ? "detached"
                            : item.tree.directory.endsWith("/repo")
                              ? "main"
                              : "worktree"}
                      </span>
                    </CommandItem>
                  )}
                </>
              )}
              ListEmptyComponent={
                <div className="text-muted-foreground py-6 text-center text-xs">
                  {refs.isPending || snapshot?.refreshing
                    ? "Loading branches..."
                    : "No branches or worktrees found"}
                </div>
              }
            />
          </CommandList>
          <div className="flex items-center gap-2 border-t p-2 text-xs">
            <span className="text-muted-foreground min-w-0 flex-1">
              {refs.error?.message ??
                snapshot?.error ??
                `${snapshot?.total_count ?? 0} ${snapshot?.total_count === 1 ? "branch" : "branches"}`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh branches and worktrees"
              title="Refresh branches and worktrees"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await refreshCodingRepository({
                    baseUrl: await getGatewayBaseURL(),
                    headers: { "X-AgentZ-Workspace-ID": workspaceId },
                    path: { projectId: project.id },
                    query: { agent_name: agentName },
                  })
                  if (result.error) toast.error(result.error.message)
                  await queryClient.resetQueries({ queryKey: queryKey.slice(0, 5) })
                })
              }
            >
              {snapshot?.refreshing || refs.isFetching ? (
                <Spinner />
              ) : (
                <RefreshCw className="size-3" />
              )}
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
