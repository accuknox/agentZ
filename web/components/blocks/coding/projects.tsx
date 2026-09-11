"use client"

import { authClient } from "@/lib/auth-client"

import { useState, useTransition } from "react"
import { useRouter } from "@bprogress/next/app"
import Link from "next/link"
import type { Route } from "next"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { ArrowUp, ArrowUpRight, FolderGit2, GitBranch, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { addCodingProject, githubRepositories, startCodingThread } from "@/lib/coding/actions"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type { CodingProject, CodingProjectDetail, CodingWorktree } from "@/lib/gateway/client"
import { deleteCodingProject, renameCodingProject, runCodingGit } from "@/lib/gateway/client"
import { createClient } from "@/lib/gateway/client/client"
import { gatewayAuthenticatedFetch, getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

export function Projects({
  projects,
  detail,
  agentNames,
  workspaceId,
  workspacePath,
}: {
  projects: CodingProject[]
  detail?: CodingProjectDetail
  agentNames: string[]
  workspaceId: string
  workspacePath: string
}) {
  const { data: actor } = authClient.useSession()
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editingName, setEditingName] = useState("")
  const [dialog, setDialog] = useState<
    { action: "rename" | "delete" } | { action: "remove"; tree: CodingWorktree }
  >()
  const [name, setName] = useState("")
  const [repository, setRepository] = useState("")
  const [agent, setAgent] = useState(agentNames[0] ?? "")
  const [checkout, setCheckout] = useState("new")
  const [prompt, setPrompt] = useState("")
  const [pending, startTransition] = useTransition()
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const repositories = useQuery(
    queryOptions({
      queryKey: ["coding", "repositories", actor?.user.id],
      queryFn: githubRepositories,
      enabled: adding && Boolean(actor),
    })
  )
  const worktrees = detail?.worktrees.filter((tree) => tree.agent_name === agent) ?? []
  const project = detail?.project

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-3 border-b px-3">
        <SidebarTrigger />
        <Link href={`${workspacePath}/projects` as Route} className="text-muted-foreground text-sm">
          Projects
        </Link>
        {project ? (
          <>
            <span className="text-muted-foreground">/</span>
            <h1 className="truncate text-sm font-medium">{project.name}</h1>
          </>
        ) : null}
        <Button
          className="ml-auto"
          size="sm"
          variant="outline"
          disabled={!agentNames.length}
          onClick={() => setAdding(!adding)}
        >
          <Plus />
          New project
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {adding ? (
          <form
            className="mx-auto grid max-w-2xl gap-4 border-b p-6"
            onSubmit={(event) => {
              event.preventDefault()
              const selected = repositories.data?.find((item) => item.name === repository)
              if (!selected) return
              startTransition(async () => {
                try {
                  const created = await addCodingProject(
                    workspaceId,
                    name || selected.name,
                    selected.id
                  )
                  setAdding(false)
                  setName("")
                  setRepository("")
                  router.push(`${workspacePath}/projects?project=${created.id}` as Route)
                } catch {
                  toast.error(
                    "Could not create the project. Check your GitHub connection and repository access."
                  )
                }
              })
            }}
          >
            <h2 className="text-lg font-semibold">Add a GitHub project</h2>
            <p className="text-muted-foreground text-sm">
              Only you can manage this project. Files and threads are accessible to everyone who can
              use its agents.
            </p>
            <label className="grid gap-2 text-sm">
              Repository
              <select
                required
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                className="bg-background rounded-md border p-2"
              >
                <option value="">
                  {repositories.isPending ? "Loading repositories…" : "Select a repository"}
                </option>
                {repositories.data?.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                    {item.private ? " · private" : ""}
                  </option>
                ))}
              </select>
            </label>
            {repositories.error ? (
              <p role="alert" className="text-destructive text-sm">
                Could not load repositories.{" "}
                <Link href="/settings/account" className="underline">
                  Check your GitHub connection
                </Link>
                .
              </p>
            ) : null}
            <label className="grid gap-2 text-sm">
              Project name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Defaults to the repository name"
                maxLength={80}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button disabled={pending || !repository} type="submit">
                Add project
              </Button>
            </div>
          </form>
        ) : null}
        {!project ? (
          <div className="mx-auto max-w-5xl p-6 md:p-10">
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight">Your projects</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                Pick a repository, start a thread, and choose an agent to do the work.
              </p>
            </div>
            {projects.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {projects.map((item) => (
                  <Link
                    key={item.id}
                    href={`${workspacePath}/projects?project=${item.id}` as Route}
                    className="bg-card hover:bg-accent/40 group rounded-lg border p-5 transition-colors"
                  >
                    <div className="mb-5 flex items-center justify-between">
                      <FolderGit2 className="text-muted-foreground size-5" />
                      <ArrowUpRight className="text-muted-foreground size-4 opacity-0 group-hover:opacity-100" />
                    </div>
                    <h2 className="truncate font-medium">{item.name}</h2>
                    <p className="text-muted-foreground mt-1 truncate text-xs">{item.repository}</p>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed px-6 py-20 text-center">
                <FolderGit2 className="text-muted-foreground size-8" />
                <h2 className="font-medium">No projects yet</h2>
                {agentNames.length ? (
                  <Button onClick={() => setAdding(true)}>Add your first project</Button>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Create an agent or ask someone to share one with you before adding a project.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl p-6 md:p-10">
            <div className="mb-8 flex items-start justify-between gap-4">
              <div>
                <p className="text-muted-foreground mb-2 text-xs">{project.repository}</p>
                <h2 className="text-2xl font-semibold tracking-tight">{project.name}</h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingName(project.name)
                  setDialog({ action: "rename" })
                }}
              >
                Rename
              </Button>
            </div>
            <form
              className="bg-card rounded-xl border shadow-sm"
              onSubmit={(event) => {
                event.preventDefault()
                startTransition(async () => {
                  try {
                    const thread = await startCodingThread(workspaceId, {
                      id: draftId,
                      project_id: project.id,
                      agent_name: agent,
                      main_checkout: checkout === "main",
                      worktree_id: checkout !== "new" && checkout !== "main" ? checkout : undefined,
                    })
                    setDraftId(crypto.randomUUID())
                    router.push(
                      `${workspacePath}/agents/${encodeURIComponent(agent)}/sessions/${thread.session_id}` as Route
                    )
                    const client = await createAgentOpencodeClient(agent, workspaceId)
                    if (prompt.trim()) {
                      const result = await client.session.promptAsync({
                        sessionID: thread.session_id,
                        parts: [{ type: "text", text: prompt.trim() }],
                      })
                      if (result.error) {
                        toast.error(
                          "Thread created, but the message could not be sent. Retry in the thread."
                        )
                      }
                    }
                  } catch {
                    toast.error(
                      "Could not start the thread. Check that the agent is running and your GitHub account can access the repository."
                    )
                  }
                })
              }}
            >
              <textarea
                aria-label="Task"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="What would you like to build?"
                className="min-h-32 w-full resize-none bg-transparent p-5 text-sm outline-none"
              />
              <div className="flex flex-wrap items-center gap-2 border-t p-3">
                <select
                  aria-label="Agent"
                  value={agent}
                  onChange={(event) => {
                    setAgent(event.target.value)
                    setCheckout("new")
                    setDraftId(crypto.randomUUID())
                  }}
                  className="bg-background max-w-48 rounded-md border px-2 py-1.5 text-xs"
                >
                  {agentNames.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <GitBranch className="text-muted-foreground ml-2 size-3.5" />
                <select
                  aria-label="Worktree"
                  value={checkout}
                  onChange={(event) => {
                    setCheckout(event.target.value)
                    setDraftId(crypto.randomUUID())
                  }}
                  className="bg-background max-w-64 rounded-md border px-2 py-1.5 text-xs"
                >
                  <option value="new">New branch and worktree</option>
                  {!worktrees.some((tree) => tree.directory.endsWith("/repo")) ? (
                    <option value="main">Main checkout</option>
                  ) : null}
                  {worktrees
                    .filter((tree) => tree.ready)
                    .map((tree) => (
                      <option key={tree.id} value={tree.id}>
                        {tree.branch} · existing checkout
                      </option>
                    ))}
                </select>
                <Button className="ml-auto" disabled={pending || !agent} type="submit" size="sm">
                  <ArrowUp />
                  {pending ? "Preparing…" : "Start thread"}
                </Button>
              </div>
            </form>
            <section className="mt-10">
              <h3 className="mb-3 text-sm font-medium">Threads</h3>
              {detail.threads.length ? (
                <div className="divide-y rounded-lg border">
                  {detail.threads.map((thread) => (
                    <Link
                      key={thread.id}
                      href={
                        `${workspacePath}/agents/${encodeURIComponent(thread.worktree.agent_name)}/sessions/${thread.session_id}` as Route
                      }
                      className="hover:bg-accent/40 flex items-center gap-3 px-4 py-3 text-sm"
                    >
                      <span className="flex-1 truncate">{thread.worktree.branch}</span>
                      <span className="text-muted-foreground text-xs">
                        {thread.worktree.agent_name}
                      </span>
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Start the first thread in this project.
                </p>
              )}
            </section>
            <section className="mt-8">
              <h3 className="mb-3 text-sm font-medium">Checkouts</h3>
              <div className="space-y-2">
                {detail.worktrees.map((tree) => (
                  <div
                    key={tree.id}
                    className="flex items-center justify-between gap-4 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm">
                        {tree.branch}{" "}
                        <span className="text-muted-foreground">· {tree.agent_name}</span>
                      </p>
                      <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                        {tree.directory}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setDialog({ action: "remove", tree })}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </section>
            <Button
              className="mt-8"
              variant="ghost"
              disabled={pending || detail.worktrees.length > 0}
              onClick={() => setDialog({ action: "delete" })}
            >
              Delete project
            </Button>
          </div>
        )}
      </div>
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
                  if (dialog.action === "remove") {
                    const result = await runCodingGit({
                      baseUrl: await getGatewayBaseURL(),
                      headers: { "X-AgentZ-Workspace-ID": workspaceId },
                      path: { worktreeId: dialog.tree.id },
                      body: { operation: "remove" },
                    })
                    if (result.error) throw new Error(result.error.message)
                  } else {
                    const client = createClient({
                      baseUrl: await getGatewayBaseURL(),
                      fetch: gatewayAuthenticatedFetch,
                      headers: { "X-AgentZ-Workspace-ID": workspaceId },
                    })
                    const result =
                      dialog.action === "rename"
                        ? await renameCodingProject({
                            client,
                            path: { projectId: project.id },
                            body: { name: editingName.trim() },
                          })
                        : await deleteCodingProject({ client, path: { projectId: project.id } })
                    if (result.error) throw new Error(result.error.message)
                  }
                  if (dialog.action === "delete") router.push(`${workspacePath}/projects` as Route)
                  else router.refresh()
                  setDialog(undefined)
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not update project")
                }
              })
            }}
          >
            {dialog?.action === "rename" ? (
              <Input
                aria-label="Project name"
                autoFocus
                required
                maxLength={80}
                value={editingName}
                onChange={(event) => setEditingName(event.target.value)}
              />
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
