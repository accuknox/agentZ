"use client"

/*
Git actions adapted from T3 Code.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { useState } from "react"
import {
  queryOptions,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { ChevronDown, CloudDownload, CloudUpload, GitCommitHorizontal, Info } from "lucide-react"
import { GitHubDark } from "@ridemountainpig/svgl-react"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import {
  codingGitHubStatus,
  codingRemoteHead,
  createCodingPullRequest,
  remoteCodingGit,
} from "@/lib/coding/actions"
import { gitQueries, gitQuickAction, runWorkspaceGit } from "@/lib/coding/review"
import { suggestCodingText, type CodingThread } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { useFileWorkspace } from "@/components/blocks/chat/file-workspace-store"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type Action = NonNullable<ReturnType<typeof gitQuickAction>["action"]> | "commit"

export function GitActions({ thread, workspaceId }: { thread: CodingThread; workspaceId: string }) {
  const { data: actor } = authClient.useSession()
  const queryClient = useQueryClient()
  const { previewFile } = useFileWorkspace()
  const tree = thread.worktree
  const mutationKey = ["coding", "git", workspaceId, tree.id]
  const busy = useIsMutating({ mutationKey }) > 0
  const statusOptions = queryOptions({
    queryKey: ["coding", "git", workspaceId, tree.id, actor?.user.id],
    queryFn: () => runWorkspaceGit(workspaceId, tree.id, { operation: "status" }),
    enabled: !!actor?.user.id,
    refetchInterval: busy ? false : 5000,
  })
  const status = useQuery(statusOptions)
  const github = useQuery(
    queryOptions({
      queryKey: [
        "coding",
        "github",
        workspaceId,
        tree.id,
        actor?.user.id,
        tree.agent_name,
        thread.session_id,
        status.data?.branch,
      ],
      queryFn: () => codingGitHubStatus(workspaceId, tree.agent_name, thread.session_id),
      enabled: !busy && status.isSuccess,
      staleTime: 30_000,
      refetchInterval: busy ? false : 30_000,
    })
  )
  const [dialog, setDialog] = useState(false)
  const [message, setMessage] = useState("")
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<Exclude<Action, "view_pr">>()
  const review = useQuery({
    ...gitQueries(
      { thread, workspaceId, visible: dialog, expanded: dialog },
      "all",
      undefined,
      false
    ).review,
    staleTime: 0,
    refetchInterval: dialog && !busy ? 5000 : false,
  })
  const stats = new Map(
    review.data?.map((file) => [
      file.path,
      {
        additions: file.diff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
        deletions: file.diff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      },
    ])
  )
  const data = status.data
  const files = data?.files ?? []
  const selected = files.filter((file) => !excluded.has(file.path))
  const quick = gitQuickAction(busy ? undefined : data, !!github.data)
  const isDefault = data?.branch === data?.default_branch
  const confirmingPR = confirmation === "create_pr" || confirmation === "commit_push_pr"
  const confirmingCommit =
    files.length > 0 && confirmation !== "push" && confirmation !== "create_pr"
  const reason = busy
    ? "Git action in progress."
    : (status.error?.message ??
      github.error?.message ??
      (github.isPending
        ? "Loading GitHub status."
        : files.some((file) => file.conflict)
          ? "Resolve conflicts before committing."
          : data && !data.head
            ? "This repository has no initial commit."
            : undefined))
  const disabledReason = reason ?? quick.hint
  const Icon =
    quick.action === "pull"
      ? CloudDownload
      : quick.label === "Push" || quick.action === "push" || quick.action === "commit_push"
        ? CloudUpload
        : quick.label === "Commit"
          ? GitCommitHorizontal
          : quick.action
            ? GitHubDark
            : Info

  const mutation = useMutation({
    mutationKey,
    mutationFn: async ({
      action,
      newBranch = false,
      message = "",
      paths,
    }: {
      action: Exclude<Action, "view_pr">
      newBranch?: boolean
      message?: string
      paths?: string[]
    }) => {
      if (!data) throw new Error("Git status is unavailable.")
      const id = toast.loading("Running Git action...", { duration: Infinity })
      let completed = ""
      try {
        let current = await runWorkspaceGit(workspaceId, tree.id, {
          operation: "status",
          expected_head: data.head,
        })
        if (current.revision !== data.revision)
          throw new Error("Checkout changed; refresh and retry.")
        if (newBranch) {
          toast.loading("Preparing feature branch...", { id })
          const suggestion = await suggestCodingText({
            baseUrl: await getGatewayBaseURL(),
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: { agentName: tree.agent_name, sessionId: thread.session_id },
            body: {
              purpose: "branch",
              text: message || current.files.map((file) => file.path).join("\n") || current.branch,
            },
          })
          if (suggestion.error) throw new Error(suggestion.error.message)
          current = await runWorkspaceGit(workspaceId, tree.id, {
            operation: "create_branch",
            ref: suggestion.data.text,
            expected_head: current.head,
          })
          completed = `Created ${current.branch}. `
        }
        if (action === "pull") {
          toast.loading("Pulling...", { id })
          await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
            operation: "pull",
            head: current.head,
          })
          toast.success("Pulled", { id })
          return
        }
        if (
          (action === "commit" || action === "commit_push" || action === "commit_push_pr") &&
          current.files.length
        ) {
          current = await runWorkspaceGit(workspaceId, tree.id, {
            operation: "prepare_commit",
            expected_head: current.head,
            revision: current.revision,
            paths,
          })
          if (!current.tree) throw new Error("Resolve conflicts before committing.")
          if (!message.trim()) {
            toast.loading("Generating commit message...", { id })
            const suggestion = await suggestCodingText({
              baseUrl: await getGatewayBaseURL(),
              headers: { "X-AgentZ-Workspace-ID": workspaceId },
              path: { agentName: tree.agent_name, sessionId: thread.session_id },
              body: { purpose: "commit", expected_tree: current.tree },
            })
            if (suggestion.error) throw new Error(suggestion.error.message)
            message = suggestion.data.text
          }
          toast.loading("Committing...", { id })
          current = await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
            operation: "commit",
            head: current.head,
            tree: current.tree,
            message,
          })
          completed += `Committed ${current.head.slice(0, 7)}. `
        }
        if (action !== "commit" && (current.ahead > 0 || !current.remote_head)) {
          toast.loading("Pushing...", { id })
          const remoteHead = await codingRemoteHead(
            workspaceId,
            tree.agent_name,
            thread.session_id,
            current.branch
          )
          current = await remoteCodingGit(workspaceId, tree.agent_name, thread.session_id, {
            operation: "push",
            head: current.head,
            remoteHead,
          })
          completed += "Pushed. "
        }
        if (action === "create_pr" || action === "commit_push_pr") {
          toast.loading("Generating PR content...", { id })
          const pr = await createCodingPullRequest(
            workspaceId,
            tree.agent_name,
            thread.session_id,
            current.head
          )
          toast.success(`Created PR #${pr.number}`, {
            id,
            description: completed,
            action: {
              label: "View PR",
              onClick: () => window.open(pr.url, "_blank", "noopener,noreferrer"),
            },
          })
          return
        }
        toast.success(action === "commit" ? "Committed" : "Pushed", { id, description: completed })
      } catch (error) {
        toast.error("Git action failed", {
          id,
          description: completed + (error instanceof Error ? error.message : "Refresh and retry."),
        })
        throw error
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "coding" &&
          query.queryKey[2] === workspaceId &&
          query.queryKey[3] === tree.id,
      }),
  })

  function run(action: Action) {
    if (busy || reason) return
    if (action === "view_pr") {
      if (github.data) window.open(github.data.url, "_blank", "noopener,noreferrer")
      return
    }
    if (isDefault && action !== "commit" && action !== "pull") {
      setConfirmation(action)
      return
    }
    mutation.mutate({ action })
  }

  const menu = [
    {
      action: "commit",
      label: "Commit",
      Icon: GitCommitHorizontal,
      hint: files.length ? undefined : "No changes to commit.",
    },
    {
      action: "push",
      label: "Push",
      Icon: CloudUpload,
      hint: !data?.branch
        ? "Select a branch before pushing."
        : data.behind
          ? "Behind upstream. Pull/rebase first."
          : !data.ahead
            ? "No local commits to push."
            : undefined,
    },
    {
      action: github.data ? "view_pr" : "create_pr",
      label: github.data ? "View PR" : "Create PR",
      Icon: GitHubDark,
      hint: github.data
        ? undefined
        : !data?.branch
          ? "Select a branch before creating a PR."
          : files.length
            ? "Commit local changes before creating a PR."
            : data.behind
              ? "Behind upstream. Pull/rebase first."
              : !data.ahead_of_default
                ? "No commits ahead of the default branch."
                : undefined,
    },
  ] as const

  return (
    <>
      <ButtonGroup aria-label="Git actions" className="shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-disabled={!!disabledReason}
              className={cn("min-w-0!", disabledReason && "cursor-not-allowed opacity-50")}
              onClick={() => {
                if (!disabledReason && quick.action) run(quick.action)
              }}
            >
              <Icon
                className={Icon === GitHubDark ? "[&_path]:fill-current" : undefined}
                aria-hidden
              />
              <span className="sr-only @3xl/header-actions:not-sr-only">{quick.label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{disabledReason ?? quick.label}</TooltipContent>
        </Tooltip>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              void status.refetch()
              void github.refetch()
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Git action options"
              variant="outline"
              size="icon-sm"
              disabled={busy}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {menu.map((item) => (
                <Tooltip key={item.action}>
                  <TooltipTrigger asChild>
                    <span className="block">
                      <DropdownMenuItem
                        disabled={!!(reason ?? item.hint)}
                        onSelect={() => {
                          if (item.action === "commit") {
                            setMessage("")
                            setExcluded(new Set())
                            setEditing(false)
                            setDialog(true)
                            return
                          }
                          run(item.action)
                        }}
                      >
                        <item.Icon
                          className={item.Icon === GitHubDark ? "[&_path]:fill-current" : undefined}
                        />
                        {item.label}
                      </DropdownMenuItem>
                    </span>
                  </TooltipTrigger>
                  {(reason ?? item.hint) ? (
                    <TooltipContent side="left">{reason ?? item.hint}</TooltipContent>
                  ) : null}
                </Tooltip>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit changes</DialogTitle>
            <DialogDescription>
              Review and confirm your commit. Leave the message blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted/30 ring-border flex flex-col gap-3 rounded-xl p-3 text-sm ring-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Branch</span>
              <span className="font-medium">{data?.branch || "(detached HEAD)"}</span>
              {isDefault ? (
                <span className="text-warning ml-auto">Warning: default refName</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {editing && files.length ? (
                <Checkbox
                  aria-label="Select all files"
                  checked={
                    selected.length === files.length
                      ? true
                      : selected.length
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={() =>
                    setExcluded(
                      selected.length === files.length
                        ? new Set(files.map((file) => file.path))
                        : new Set()
                    )
                  }
                />
              ) : null}
              <span className="text-muted-foreground">Files</span>
              {excluded.size && !editing ? (
                <span className="text-muted-foreground">
                  ({selected.length} of {files.length})
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => setEditing(!editing)}
              >
                {editing ? "Done" : "Edit"}
              </Button>
            </div>
            <div className="bg-card ring-border h-44 overflow-auto rounded-lg ring-1">
              <div className="flex flex-col gap-1 p-1">
                {files.map((file) => (
                  <div
                    key={file.path}
                    className="hover:bg-accent/50 flex items-center gap-2 rounded-md px-2 py-1 font-mono"
                  >
                    {editing ? (
                      <Checkbox
                        aria-label={`Include ${file.path}`}
                        checked={!excluded.has(file.path)}
                        onCheckedChange={() =>
                          setExcluded((value) => {
                            const next = new Set(value)
                            if (next.has(file.path)) next.delete(file.path)
                            else next.add(file.path)
                            return next
                          })
                        }
                      />
                    ) : null}
                    <button
                      className={cn(
                        "min-w-0 flex-1 truncate text-left",
                        excluded.has(file.path) && "text-muted-foreground"
                      )}
                      title={file.path}
                      onClick={() =>
                        previewFile(tree.agent_name, {
                          name: file.path.split("/").at(-1) ?? file.path,
                          path: `${tree.directory.slice("/home/agentz/".length)}/${file.path}`,
                        })
                      }
                    >
                      {file.path}
                    </button>
                    {excluded.has(file.path) ? (
                      <span className="text-muted-foreground">Excluded</span>
                    ) : stats.has(file.path) ? (
                      <span className="shrink-0">
                        <span className="text-success">+{stats.get(file.path)?.additions}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-destructive">-{stats.get(file.path)?.deletions}</span>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="text-right font-mono">
              <span className="text-success">
                +{selected.reduce((sum, file) => sum + (stats.get(file.path)?.additions ?? 0), 0)}
              </span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">
                -{selected.reduce((sum, file) => sum + (stats.get(file.path)?.deletions ?? 0), 0)}
              </span>
            </div>
            {review.error ? <p className="text-destructive">{review.error.message}</p> : null}
          </div>
          <Field>
            <FieldLabel htmlFor={`quick-commit-${tree.id}`}>Commit message (optional)</FieldLabel>
            <Textarea
              id={`quick-commit-${tree.id}`}
              placeholder="Leave empty to auto-generate"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={20_000}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!selected.length || busy}
              onClick={() => {
                setDialog(false)
                mutation.mutate({
                  action: "commit",
                  newBranch: true,
                  message,
                  paths: excluded.size ? selected.map((file) => file.path) : undefined,
                })
              }}
            >
              Commit on new refName
            </Button>
            <Button
              size="sm"
              disabled={!selected.length || busy}
              onClick={() => {
                setDialog(false)
                mutation.mutate({
                  action: "commit",
                  message,
                  paths: excluded.size ? selected.map((file) => file.path) : undefined,
                })
              }}
            >
              Commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {confirmingPR
                ? confirmingCommit
                  ? "Commit, push & create PR from default ref?"
                  : "Push & create PR from default ref?"
                : confirmingCommit
                  ? "Commit & push to default ref?"
                  : "Push to default ref?"}
            </DialogTitle>
            <DialogDescription>
              This action will {confirmingCommit ? "commit and push changes" : "push local commits"}
              {confirmingPR ? " and create a pull request" : ""} on &quot;{data?.branch}&quot;. You
              can continue on this ref or create a feature ref and run the same action there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="sm:mr-auto"
              onClick={() => setConfirmation(undefined)}
            >
              Abort
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirmation) mutation.mutate({ action: confirmation })
                setConfirmation(undefined)
              }}
            >
              {confirmingPR
                ? confirmingCommit
                  ? "Commit, push & create PR"
                  : "Push & create PR"
                : `${confirmingCommit ? "Commit & push" : "Push"} to ${data?.branch}`}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (confirmation) mutation.mutate({ action: confirmation, newBranch: true })
                setConfirmation(undefined)
              }}
            >
              Checkout feature branch & continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
