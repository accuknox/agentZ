"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "@bprogress/next/app"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import {
  ArrowUpRight,
  CircleAlert,
  Ellipsis,
  Settings2,
  ChevronDown,
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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { opencodeErrorMessage } from "@/components/blocks/chat/errors"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
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
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { addCodingProject, githubRepositories, startCodingThread } from "@/lib/coding/actions"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type {
  ChatSessionPreference,
  CodingProject,
  CodingProjectDetail,
  CodingWorktree,
} from "@/lib/gateway/client"
import {
  deleteCodingProject,
  renameCodingProject,
  runCodingGit,
  suggestCodingText,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

export function Projects({
  projects,
  detail,
  agentNames,
  agentName,
  chatPreferences,
  workspaceId,
  workspacePath,
}: {
  projects: CodingProject[]
  detail?: CodingProjectDetail
  agentNames: string[]
  agentName: string
  chatPreferences: ChatSessionPreference
  workspaceId: string
  workspacePath: `/orgs/${string}/workspaces/${string}`
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
  const [editingName, setEditingName] = useState("")
  const [dialog, setDialog] = useState<
    { action: "rename" | "delete" } | { action: "remove"; tree: CodingWorktree }
  >()
  const [name, setName] = useState("")
  const [repository, setRepository] =
    useState<Awaited<ReturnType<typeof githubRepositories>>["repositories"][number]>()
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [repositorySearch, setRepositorySearch] = useState("")
  const [repositoryQuery, setRepositoryQuery] = useState("")
  const [checkout, setCheckout] = useState("new")
  const [pending, startTransition] = useTransition()
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    const timer = setTimeout(() => setRepositoryQuery(repositorySearch.trim()), 300)
    return () => clearTimeout(timer)
  }, [repositorySearch])
  const repositories = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: ["coding", "repositories", actor?.user.id, repositoryQuery],
      queryFn: ({ pageParam }) => githubRepositories(repositoryQuery, pageParam),
      initialPageParam: 1,
      getNextPageParam: (lastPage) => lastPage.nextPage,
      enabled: adding && repositoryOpen && Boolean(actor),
      staleTime: 60_000,
      retry: false,
    })
  )
  const searching = repositorySearch.trim() !== repositoryQuery || repositories.isPending
  const worktrees = detail?.worktrees.filter((tree) => tree.agent_name === agentName) ?? []
  const project = detail?.project
  const draftTarget = `${project?.id}:${agentName}:${search.get("draft")}`
  const [previousTarget, setPreviousTarget] = useState(draftTarget)
  if (previousTarget !== draftTarget) {
    setPreviousTarget(draftTarget)
    setCheckout("new")
    setDraftId(crypto.randomUUID())
  }

  return (
    <main className={cn("flex min-w-0 flex-1 flex-col p-0", !project && "gap-6")}>
      {!project ? (
        <AdministrationPageHeader
          title="Projects"
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={!agentNames.length}
              onClick={() => setAdding(true)}
            >
              <Plus data-icon="inline-start" /> New project
            </Button>
          }
        />
      ) : null}
      {!project ? (
        projects.length ? (
          <div className="grid gap-3 px-4 pb-6 sm:grid-cols-2 md:px-6 xl:grid-cols-3">
            {projects.map((item) => (
              <Link
                key={item.id}
                href={`${workspacePath}/projects?${new URLSearchParams({ ...Object.fromEntries(draftQuery), project: item.id })}`}
                className="group focus-visible:ring-ring rounded-xl outline-none focus-visible:ring-2"
              >
                <Card className="group-hover:bg-accent/40 h-full transition-colors">
                  <CardHeader>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                        <FolderGit2 className="size-5" aria-hidden="true" />
                      </div>
                      <ArrowUpRight
                        className="text-muted-foreground group-hover:text-foreground size-4 transition-colors"
                        aria-hidden="true"
                      />
                    </div>
                    <CardTitle>
                      <h2 className="truncate">{item.name}</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground truncate text-xs">{item.repository}</p>
                    <div className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
                      <GitBranch className="size-3.5" aria-hidden="true" />
                      <span className="truncate">{item.default_branch}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
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
        )
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label="Project options"
                >
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
            <Select
              value={checkout}
              disabled={disabled}
              onValueChange={(value) => {
                setCheckout(value)
                setDraftId(crypto.randomUUID())
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Worktree"
                className="hover:bg-foreground/5 h-7 max-w-64 min-w-0 border-0 bg-transparent px-1.5 text-xs shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" position="popper" side="top" sideOffset={6}>
                <SelectGroup>
                  <SelectItem value="new">
                    <GitBranch aria-hidden="true" />
                    New worktree
                  </SelectItem>
                  {!worktrees.some((tree) => tree.directory.endsWith("/repo")) ? (
                    <SelectItem value="main">
                      <GitBranch aria-hidden="true" />
                      Main checkout
                    </SelectItem>
                  ) : null}
                  {worktrees
                    .filter((tree) => tree.ready)
                    .map((tree) => (
                      <SelectItem key={tree.id} value={tree.id}>
                        <GitBranch aria-hidden="true" />
                        {tree.branch} · existing checkout
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          createSession={async ({ text, model }) => {
            const thread = await startCodingThread(workspaceId, {
              id: draftId,
              project_id: project.id,
              agent_name: agentName,
              main_checkout: checkout === "main",
              worktree_id: checkout !== "new" && checkout !== "main" ? checkout : undefined,
            })
            if (
              checkout === "new" &&
              text &&
              thread.worktree.branch === `chore/${thread.worktree.id}`
            ) {
              void (async () => {
                try {
                  const options = {
                    baseUrl: await getGatewayBaseURL(),
                    headers: { "X-AgentZ-Workspace-ID": workspaceId },
                  }
                  const suggestion = await suggestCodingText({
                    ...options,
                    path: { agentName, sessionId: thread.session_id },
                    body: {
                      purpose: "branch",
                      text: text.slice(0, 16000),
                      model: { modelID: model.modelID, providerID: model.providerID },
                    },
                  })
                  if (suggestion.error) throw new Error(suggestion.error.message)
                  const status = await runCodingGit({
                    ...options,
                    path: { worktreeId: thread.worktree.id },
                    body: { operation: "status" },
                  })
                  if (status.error) throw new Error(status.error.message)
                  const renamed = await runCodingGit({
                    ...options,
                    path: { worktreeId: thread.worktree.id },
                    body: {
                      operation: "rename",
                      expected_head: status.data.head,
                      ref: `${suggestion.data.text}-${thread.worktree.id.slice(0, 8)}`,
                    },
                  })
                  if (renamed.error) throw new Error(renamed.error.message)
                } catch {
                  toast.warning("Could not name the branch. Using its temporary name.")
                }
              })()
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
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>{project?.repository}</DialogDescription>
          </DialogHeader>
          {detail ? (
            <>
              <section>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <GitBranch className="text-primary size-4" aria-hidden="true" />
                  Checkouts<Badge variant="secondary">{detail.worktrees.length}</Badge>
                </h3>
                <div className="flex flex-col gap-2">
                  {detail.worktrees.map((tree) => (
                    <div
                      key={tree.id}
                      className="flex items-center justify-between gap-4 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {tree.branch}{" "}
                          <span className="text-muted-foreground">· {tree.agent_name}</span>
                        </p>
                        <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                          {tree.directory}
                        </p>
                      </div>
                      <Badge variant={tree.ready ? "success" : "pending"}>
                        {tree.ready ? "Ready" : "Preparing"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setSettingsOpen(false)
                          setDialog({ action: "remove", tree })
                        }}
                      >
                        <Trash2 data-icon="inline-start" />
                        Remove
                      </Button>
                    </div>
                  ))}
                  {!detail.worktrees.length ? (
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
              <Button
                className="mt-8"
                variant="ghost"
                disabled={pending || detail.worktrees.length > 0}
                onClick={() => {
                  setSettingsOpen(false)
                  setDialog({ action: "delete" })
                }}
              >
                <Trash2 data-icon="inline-start" />
                Delete project
              </Button>
              {detail.worktrees.length ? (
                <p className="text-muted-foreground mt-2 text-xs">
                  Remove all checkouts before deleting this project.
                </p>
              ) : null}
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
                  const created = await addCodingProject(
                    workspaceId,
                    name || repository.name,
                    repository.id
                  )
                  setAdding(false)
                  setName("")
                  setRepository(undefined)
                  router.push(
                    `${workspacePath}/projects?${new URLSearchParams({ ...Object.fromEntries(draftQuery), project: created.id })}`
                  )
                  router.refresh()
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
                      <CommandList>
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
                    {!searching && repositories.hasNextPage ? (
                      <div className="p-2">
                        <Button
                          type="button"
                          variant="ghost"
                          className="w-full"
                          disabled={repositories.isFetchingNextPage}
                          onClick={() => void repositories.fetchNextPage()}
                        >
                          {repositories.isFetchingNextPage ? (
                            <Spinner data-icon="inline-start" />
                          ) : null}
                          {repositories.isFetchNextPageError ? "Retry loading more" : "Load more"}
                        </Button>
                      </div>
                    ) : null}
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
              if (!dialog || !project) return
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
                            path: { projectId: project.id },
                            body: { name: editingName.trim() },
                          })
                        : await deleteCodingProject({ ...options, path: { projectId: project.id } })
                    if (result.error) throw new Error(result.error.message)
                  }
                  if (dialog.action === "delete") router.replace(`${workspacePath}/projects`)
                  if (dialog.action === "remove" && dialog.tree.id === checkout) {
                    setCheckout("new")
                    setDraftId(crypto.randomUUID())
                  }
                  router.refresh()
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
