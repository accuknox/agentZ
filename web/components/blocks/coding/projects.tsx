"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "@bprogress/next/app"
import Link from "next/link"
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { useSearchParams } from "next/navigation"
import { infiniteQueryOptions, useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  Ellipsis,
  Settings2,
  ChevronDown,
  RefreshCw,
  FolderGit2,
  GitBranch,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { opencodeErrorMessage } from "@/components/blocks/chat/errors"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AdministrationPageHeader,
  AdministrationState,
  type AdministrationPageScope,
} from "@/components/administration"
import { ProjectTable } from "./project-table"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type {
  ChatSessionPreference,
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
  createCodingThread,
  listCodingRefs,
  adoptCodingWorktree,
  refreshCodingRepository,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { runWorkspaceGit, startWorkspaceOperation } from "@/lib/coding/review"

export function Projects({
  projects,
  detail,
  agentNames,
  agentName,
  chatPreferences,
  workspaceId,
  workspacePath,
  pageScope,
}: {
  projects: CodingProject[]
  detail?: CodingProjectDetail
  agentNames: string[]
  agentName: string
  chatPreferences: ChatSessionPreference
  workspaceId: string
  workspacePath: `/orgs/${string}/workspaces/${string}`
  pageScope: AdministrationPageScope
}) {
  const { data: actor } = authClient.useSession()
  const router = useRouter()
  const search = useSearchParams()
  const draftQuery = new URLSearchParams(search)
  draftQuery.delete("new")
  draftQuery.delete("project")
  const [creatingProject, setAdding] = useState(false)
  const adding = creatingProject || search.get("new") === "true"
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [managedProject, setManagedProject] = useState<CodingProject>()
  const [projectSettings, setProjectSettings] = useState<CodingProjectDetail>()
  const [editingName, setEditingName] = useState("")
  const [dialog, setDialog] = useState<
    { action: "rename" | "delete" } | { action: "remove"; tree: CodingWorktree }
  >()
  const [name, setName] = useState("")
  const [repository, setRepository] = useState<CodingRepositoryItem>()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [repositorySearch, setRepositorySearch] = useState("")
  const [repositoryQuery, setRepositoryQuery] = useState("")
  const [checkout, setCheckout] = useState("new")
  const [baseRef, setBaseRef] = useState<string>()
  const [pending, startTransition] = useTransition()
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
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
  const project = detail?.project
  const targetProject = project ?? managedProject
  const settings = project ? detail : projectSettings
  const draftTarget = `${project?.id}:${agentName}:${search.get("draft")}`
  const [previousTarget, setPreviousTarget] = useState(draftTarget)
  if (previousTarget !== draftTarget) {
    setPreviousTarget(draftTarget)
    setCheckout("new")
    setBaseRef(undefined)
    setDraftId(crypto.randomUUID())
  }

  const onProjectAction = useCallback(
    (item: CodingProject, action: "settings" | "rename") => {
      setManagedProject(item)
      if (action === "rename") {
        setEditingName(item.name)
        setDialog({ action: "rename" })
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
          setProjectSettings(result.data)
          setSettingsOpen(true)
        } catch {
          toast.error("Could not load project settings")
        }
      })
    },
    [setDialog, setEditingName, setSettingsOpen, startTransition, workspaceId]
  )

  return (
    <main className={cn("flex min-w-0 flex-1 flex-col p-0", !project && "gap-6")}>
      {!project ? (
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
      {!project ? (
        <ProjectTable
          projects={projects}
          rowHref={(item) =>
            `?${new URLSearchParams({ ...Object.fromEntries(draftQuery), project: item.id })}`
          }
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
      ) : !agentName ? (
        <AdministrationState
          kind="empty"
          title="No agent is ready for chat"
          description="Create an agent or ask a workspace administrator for access."
          actions={
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              Project settings
            </Button>
          }
        />
      ) : (
        <ChatShell
          key={project.id}
          draftId={project.id}
          agentName={agentName}
          agentNames={agentNames}
          chatPreferences={chatPreferences}
          title="New thread"
          draftPath={`${workspacePath}/projects`}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          headerContext={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 max-w-full px-1.5 font-medium"
                  aria-label="Change project"
                >
                  <span className="truncate">{project.name}</span>
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="max-w-80">
                {projects.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={() =>
                      router.push(
                        `${workspacePath}/projects?${new URLSearchParams({ ...Object.fromEntries(draftQuery), project: item.id })}`
                      )
                    }
                  >
                    <FolderGit2 className="text-primary" />
                    <span className="truncate">{item.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setAdding(true)}>
                  <Plus /> New project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
          headerActions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Project options">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                  <Settings2 /> Project settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setEditingName(project.name)
                    setDialog({ action: "rename" })
                  }}
                >
                  <Pencil /> Rename project
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href={`${workspacePath}/projects`}>
                    <FolderGit2 /> All projects
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
          composerContext={(disabled) => (
            <CheckoutPicker
              key={draftTarget}
              project={project}
              agentName={agentName}
              workspaceId={workspaceId}
              checkout={checkout}
              baseRef={baseRef}
              disabled={disabled}
              onChange={(value, ref) => {
                setCheckout(value)
                setBaseRef(ref)
                setDraftId(crypto.randomUUID())
              }}
            />
          )}
          createSession={async ({ text, model }) => {
            const result = await createCodingThread({
              baseUrl: await getGatewayBaseURL(),
              headers: { "X-AgentZ-Workspace-ID": workspaceId },
              body: {
                id: draftId,
                project_id: project.id,
                agent_name: agentName,
                main_checkout: checkout === "main",
                worktree_id: checkout !== "new" && checkout !== "main" ? checkout : undefined,
                base_ref: checkout === "new" ? baseRef : undefined,
              },
            })
            if (result.error) throw new Error(result.error.message)
            const thread = result.data
            if (
              checkout === "new" &&
              text &&
              thread.worktree.branch === `chore/${thread.worktree.id}`
            ) {
              try {
                const status = await runWorkspaceGit(workspaceId, thread.worktree.id, {
                  operation: "status",
                })
                await startWorkspaceOperation(workspaceId, {
                  id: thread.id,
                  agent_name: agentName,
                  session_id: thread.session_id,
                  action: "name_branch",
                  branch: status.branch,
                  expected_head: status.head,
                  revision: status.revision,
                  text: text.slice(0, 16000),
                  model: { modelID: model.modelID, providerID: model.providerID },
                })
              } catch {
                toast.warning("Could not name the branch. Using its temporary name.")
              }
            }
            const client = await createAgentOpencodeClient(agentName, workspaceId)
            const session = await client.session.get({ sessionID: thread.session_id })
            if (session.error)
              throw new Error(opencodeErrorMessage(session.error, "Could not load the new thread"))
            return session.data
          }}
        />
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
            <DialogDescription>
              Only you can manage this project. Files and threads are accessible to everyone who can
              use its agents.
            </DialogDescription>
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
                  setAdding(false)
                  setName("")
                  setRepository(undefined)
                  router.push(
                    `${workspacePath}/projects?${new URLSearchParams({ ...Object.fromEntries(draftQuery), project: created.id })}`
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
                            <CommandEmpty>No repositories found.</CommandEmpty>
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
                    {!searching && repositories.data?.pages.some((page) => page.limited) ? (
                      <p className="text-muted-foreground px-3 pb-3 text-xs">
                        More repositories may match. Narrow your search to find them.
                      </p>
                    ) : null}
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
                  if (dialog.action === "delete" && project) {
                    router.replace(`${workspacePath}/projects`)
                  } else {
                    router.refresh()
                  }
                  if (dialog.action === "remove" && dialog.tree.id === checkout) {
                    setCheckout("new")
                    setDraftId(crypto.randomUUID())
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
                  ? "Working…"
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
    </main>
  )
}

function CheckoutPicker({
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
                      className="h-8 text-xs"
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
                      className="h-8 text-xs"
                      data-checked={checkout === "new" && baseRef === item.branch.ref}
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
                      className="h-8 text-xs"
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
