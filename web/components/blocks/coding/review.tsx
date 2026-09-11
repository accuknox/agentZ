"use client"

import { authClient } from "@/lib/auth-client"

import { useState, useTransition } from "react"
import dynamic from "next/dynamic"
import { queryOptions, useQuery } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  Check,
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
import { PatchDiff } from "@pierre/diffs/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { remoteCodingGit, codingGitHubInfo, createCodingPullRequest } from "@/lib/coding/actions"
import { runCodingGit, type CodingThread, type CodingGitRequest } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

const CodingTerminal = dynamic(() => import("./terminal").then((module) => module.CodingTerminal), {
  ssr: false,
})

export function CodingReview({
  thread,
  workspaceId,
  onClose,
}: {
  thread: CodingThread
  workspaceId: string
  onClose: () => void
}) {
  const { data: actor } = authClient.useSession()
  const [tab, setTab] = useState<"changes" | "github" | "terminal">("changes")
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
      refetchInterval: pending ? false : 5000,
    })
  )
  const github = useQuery(
    queryOptions({
      queryKey: [
        "coding",
        "github",
        workspaceId,
        tree.id,
        tree.agent_name,
        thread.session_id,
        actor?.user.id,
      ],
      queryFn: () => codingGitHubInfo(workspaceId, tree.agent_name, thread.session_id),
      enabled: tab === "github" && Boolean(actor),
    })
  )
  const data = status.data
  return (
    <aside aria-label="Code" className="flex h-full min-h-0 w-full flex-col border-l lg:w-[46%]">
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b px-3">
        <Button
          className="lg:hidden"
          size="icon-sm"
          aria-label="Back to chat"
          variant="ghost"
          onClick={onClose}
        >
          <X />
        </Button>
        <Button
          size="sm"
          variant={tab === "changes" ? "secondary" : "ghost"}
          onClick={() => setTab("changes")}
        >
          Changes
        </Button>
        <Button
          size="sm"
          variant={tab === "github" ? "secondary" : "ghost"}
          onClick={() => setTab("github")}
        >
          GitHub
        </Button>
        <Button
          size="icon-sm"
          aria-label="Terminal"
          variant={tab === "terminal" ? "secondary" : "ghost"}
          onClick={() => setTab("terminal")}
        >
          <TerminalSquare />
        </Button>
        <Button
          className="ml-auto"
          size="icon-sm"
          aria-label="Refresh changes"
          variant="ghost"
          onClick={() => {
            void status.refetch()
            if (tab === "github") void github.refetch()
          }}
        >
          <RefreshCw className={status.isFetching ? "animate-spin" : ""} />
        </Button>
      </div>
      {tab === "terminal" ? (
        <CodingTerminal
          agentName={tree.agent_name}
          sessionId={thread.session_id}
          directory={tree.directory}
          workspaceId={workspaceId}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {status.error ? (
            <p role="alert" className="text-destructive p-4 text-sm">
              Changes are unavailable. Check that the agent is running, then refresh.
            </p>
          ) : null}
          {data ? (
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitBranch className="text-muted-foreground size-4" />
              <select
                aria-label="Current branch"
                value={data.branch}
                disabled={pending}
                className="bg-background min-w-0 flex-1 text-sm"
                onChange={(event) => {
                  const ref = event.target.value
                  startTransition(async () => {
                    try {
                      await localGit(workspaceId, tree.id, {
                        operation: "checkout",
                        ref,
                        expected_head: data.head,
                      })
                      await status.refetch()
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "Could not switch branch"
                      )
                    }
                  })
                }}
              >
                {data.branches.map((branch) => (
                  <option key={branch}>{branch}</option>
                ))}
              </select>
              <span className="text-muted-foreground font-mono text-xs">
                {data.head.slice(0, 7)}
              </span>
            </div>
          ) : null}
          {tab === "changes" && data ? (
            <>
              <div className="border-b p-4">
                {data.files.length ? (
                  data.files.map((file) => (
                    <div key={file.path} className="flex items-center gap-2 py-1">
                      <span className="text-muted-foreground w-6 font-mono text-xs">
                        {file.index}
                        {file.worktree}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                        {file.path}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Stage ${file.path}`}
                        disabled={pending || (file.worktree === " " && file.index !== "?")}
                        onClick={() =>
                          startTransition(async () => {
                            try {
                              await localGit(workspaceId, tree.id, {
                                operation: "stage",
                                paths: [file.path],
                                expected_head: data.head,
                              })
                              await status.refetch()
                            } catch (error) {
                              toast.error(
                                error instanceof Error ? error.message : "Could not stage file"
                              )
                            }
                          })
                        }
                      >
                        <Plus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Unstage ${file.path}`}
                        disabled={pending || file.index === " " || file.index === "?"}
                        onClick={() =>
                          startTransition(async () => {
                            try {
                              await localGit(workspaceId, tree.id, {
                                operation: "unstage",
                                paths: [
                                  file.path,
                                  ...(file.previous_path ? [file.previous_path] : []),
                                ],
                                expected_head: data.head,
                              })
                              await status.refetch()
                            } catch (error) {
                              toast.error(
                                error instanceof Error ? error.message : "Could not unstage file"
                              )
                            }
                          })
                        }
                      >
                        <Minus />
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Check className="size-4" />
                    Working tree is clean
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 p-3">
                <Button
                  size="sm"
                  variant={staged ? "ghost" : "secondary"}
                  onClick={() => setStaged(false)}
                >
                  Working changes
                </Button>
                <Button
                  size="sm"
                  variant={staged ? "secondary" : "ghost"}
                  onClick={() => setStaged(true)}
                >
                  Staged changes
                </Button>
              </div>
              {(staged ? data.staged_diff : data.diff) ? (
                <PatchDiff
                  patch={staged ? data.staged_diff : data.diff}
                  options={{ diffStyle: "unified" }}
                />
              ) : (
                <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                  {staged ? "Stage files to review a commit." : "No tracked file changes."}
                </p>
              )}
              <form
                className="border-t p-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  const treeHash = data.tree
                  if (!treeHash) return
                  startTransition(async () => {
                    try {
                      await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
                        operation: "commit",
                        head: data.head,
                        tree: treeHash,
                        message,
                      })
                      setMessage("")
                      await status.refetch()
                      toast.success("Committed")
                    } catch {
                      toast.error(
                        "Could not commit. Check your GitHub connection and review the staged changes again."
                      )
                    }
                  })
                }}
              >
                <label className="grid gap-2 text-sm">
                  Commit message
                  <Input
                    value={message}
                    maxLength={20_000}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Describe this change"
                  />
                </label>
                <Button
                  type="submit"
                  className="mt-3 w-full"
                  disabled={pending || !staged || !message.trim() || !data.staged_diff}
                >
                  <GitCommitHorizontal />
                  Commit staged changes
                </Button>
                <p className="text-muted-foreground mt-2 text-xs">
                  Review the staged diff before committing. Your connected GitHub account supplies
                  the author identity.
                </p>
              </form>
            </>
          ) : null}
          {tab === "github" ? (
            <div className="space-y-6 p-4">
              {github.error ? (
                <p role="alert" className="text-destructive text-sm">
                  Could not load GitHub. Check your account connection and repository access.
                </p>
              ) : null}
              {github.isPending ? (
                <p className="text-muted-foreground text-sm">Loading GitHub…</p>
              ) : null}
              {github.data && data ? (
                <>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          try {
                            await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
                              operation: "pull",
                              head: data.head,
                            })
                            await status.refetch()
                            await github.refetch()
                          } catch {
                            toast.error(
                              "Could not pull. Check repository access and commit or discard local changes first."
                            )
                          }
                        })
                      }
                    >
                      <ArrowDown />
                      Pull
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => {
                        const remoteHead = github.data?.branchHead
                        if (remoteHead === undefined) return
                        startTransition(async () => {
                          try {
                            await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
                              operation: "push",
                              head: data.head,
                              remoteHead,
                            })
                            await status.refetch()
                            await github.refetch()
                            toast.success("Pushed")
                          } catch {
                            toast.error(
                              "Could not push. Check repository access and refresh the remote branch before retrying."
                            )
                          }
                        })
                      }}
                    >
                      <ArrowUp />
                      Push
                    </Button>
                  </div>
                  <form
                    className="grid gap-3 rounded-lg border p-4"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const base = github.data?.defaultBranch
                      if (!base) return
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
                              onClick: () => window.open(url, "_blank", "noopener,noreferrer"),
                            },
                          })
                          await github.refetch()
                        } catch {
                          toast.error(
                            "Could not create the pull request. Check repository access and push the branch first."
                          )
                        }
                      })
                    }}
                  >
                    <h3 className="text-sm font-medium">Open a pull request</h3>
                    <Input
                      aria-label="Pull request title"
                      placeholder="Title"
                      value={prTitle}
                      onChange={(event) => setPrTitle(event.target.value)}
                      maxLength={256}
                    />
                    <textarea
                      aria-label="Pull request description"
                      placeholder="Describe your changes"
                      value={prBody}
                      onChange={(event) => setPrBody(event.target.value)}
                      className="min-h-24 rounded-md border p-2 text-sm"
                    />
                    <Button variant="outline" type="submit" disabled={pending || !prTitle.trim()}>
                      <GitPullRequest />
                      Create pull request
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      {data.branch} → {github.data.defaultBranch}
                    </p>
                  </form>
                  <section>
                    <h3 className="mb-2 text-sm font-medium">Pull requests</h3>
                    {github.data.pulls.map((pull) => (
                      <a
                        key={pull.number}
                        href={pull.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:bg-accent block rounded-md px-2 py-2 text-sm"
                      >
                        <span className="text-muted-foreground mr-2">#{pull.number}</span>
                        {pull.title}
                      </a>
                    ))}
                    {!github.data.pulls.length ? (
                      <p className="text-muted-foreground text-sm">No open pull requests.</p>
                    ) : null}
                  </section>
                  <section>
                    <h3 className="mb-2 text-sm font-medium">Issues</h3>
                    {github.data.issues.map((issue) => (
                      <a
                        key={issue.number}
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:bg-accent block rounded-md px-2 py-2 text-sm"
                      >
                        <span className="text-muted-foreground mr-2">#{issue.number}</span>
                        {issue.title}
                      </a>
                    ))}
                    {!github.data.issues.length ? (
                      <p className="text-muted-foreground text-sm">No open issues.</p>
                    ) : null}
                  </section>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
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
