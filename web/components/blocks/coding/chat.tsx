"use client"

import { useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useRouter } from "@bprogress/next/app"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { Spinner } from "@/components/ui/spinner"
import { opencodeErrorMessage } from "@/components/blocks/chat/errors"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  prepareCodingCheckout,
  updateCodingProjectPreference,
  type CodingProject,
  type ChatSessionPreference,
} from "@/lib/gateway/client"
import { runWorkspaceGit, startWorkspaceOperation } from "@/lib/coding/review"
import { CheckoutPicker } from "./projects"
import { sessionDrafts, useSessionDraft, type DraftMetadata } from "../chat/drafts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Info } from "lucide-react"

export function CodingChat({
  project,
  greetingIndex,
  agentNames,
  chatPreferences,
  workspaceId,
  workspacePath,
}: {
  project: CodingProject
  greetingIndex: number
  agentNames: string[]
  chatPreferences: ChatSessionPreference
  workspaceId: string
  workspacePath: `/orgs/${string}/workspaces/${string}`
}) {
  const { data: actor } = authClient.useSession()
  const scope = actor ? `${actor.user.id}:${workspaceId}` : ""
  const pathname = usePathname()
  const search = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const id = search.get("draft")
  const savedDraft = useSessionDraft(scope, id)
  const [promoted, setPromoted] = useState<DraftMetadata>()
  const promotedPath = promoted?.sessionID
    ? `${workspacePath}/agents/${encodeURIComponent(promoted.agentName)}/sessions/${encodeURIComponent(promoted.sessionID)}`
    : undefined
  // Keep the live session during promotion, without disabling saves in later drafts.
  const promotedDraft = id === promoted?.id || pathname === promotedPath ? promoted : undefined
  const draft = savedDraft?.projectId === project.id ? savedDraft : promotedDraft
  const [ready, setReady] = useState(false)
  const selected =
    [
      search.get("agent"),
      project.last_agent_name,
      chatPreferences.last_agent_name,
      agentNames[0],
    ].find((name) => name && agentNames.includes(name)) ?? ""
  useEffect(() => {
    if (!scope || !selected || promotedDraft) return
    let active = true
    void sessionDrafts
      .load(scope)
      .catch(() => [])
      .then(async (saved) => {
        if (!active) return
        if (saved.some((item) => item.id === id && item.projectId === project.id)) {
          setReady(true)
          return
        }
        const created = await sessionDrafts.start(
          scope,
          project.id,
          selected,
          ready ? undefined : (id ?? undefined)
        )
        if (!active) return
        setReady(true)
        router.replace(
          `${workspacePath}/sessions/new?${new URLSearchParams({ project: project.id, draft: created.id })}`
        )
      })
    return () => {
      active = false
    }
  }, [scope, selected, id, promotedDraft, project.id, ready, router, savedDraft, workspacePath])
  const rememberAgent = async (name: string) => {
    const result = await updateCodingProjectPreference({
      baseUrl: await getGatewayBaseURL(),
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      path: { projectId: project.id },
      body: { agent_name: name },
    })
    if (result.error) {
      toast.error("Could not remember this project's agent")
      return
    }
    await queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === "chatSessions" && query.queryKey[1] === workspaceId,
    })
  }
  if (!selected)
    return (
      <Alert variant="info" className="p-6">
        <Info aria-hidden="true" />
        <AlertDescription>
          No agent is available. Ask a workspace administrator for access.
        </AlertDescription>
      </Alert>
    )
  if (!ready || !draft)
    return (
      <div
        role="status"
        className="m-auto flex items-center gap-2 p-6 text-sm text-muted-foreground"
      >
        <Spinner /> Preparing chat...
      </div>
    )
  const agentName = agentNames.includes(draft.agentName) ? draft.agentName : selected
  return (
    <ChatShell
      key={draft.id}
      draftId={draft.id}
      agentName={agentName}
      agentNames={agentNames}
      chatPreferences={chatPreferences}
      title="New chat"
      projectName={project.name}
      greetingIndex={greetingIndex}
      draftPath={`${workspacePath}/sessions/new`}
      workspaceId={workspaceId}
      workspacePath={workspacePath}
      initialMessage={sessionDrafts.get(scope, draft.id)?.message}
      draftModel={draft.model}
      draftMode={draft.mode}
      onDraftModeChange={(mode) => sessionDrafts.update(scope, draft.id, { mode })}
      onDraftModelChange={(model) => sessionDrafts.update(scope, draft.id, { model })}
      onDraftPromoted={(sessionID) => {
        const current = sessionDrafts.get(scope, draft.id)
        if (!current) return
        const { message: _message, submission: _submission, ...metadata } = current
        setPromoted({ ...metadata, sessionID })
        sessionDrafts.remove(scope, draft.id)
      }}
      onDraftAgentChange={(name) => {
        sessionDrafts.update(scope, draft.id, {
          agentName: name,
          sessionID: undefined,
          checkout: "new",
          baseRef: undefined,
        })
        void rememberAgent(name)
      }}
      headerContext={<span title={project.repository}>{project.name}</span>}
      composerContext={(disabled) => (
        <CheckoutPicker
          key={draft.agentName}
          project={project}
          agentName={agentName}
          workspaceId={workspaceId}
          checkout={draft.checkout}
          baseRef={draft.baseRef}
          disabled={disabled}
          onChange={(value, ref) => {
            sessionDrafts.update(scope, draft.id, { checkout: value, baseRef: ref })
          }}
        />
      )}
      createSession={async ({ text, model, onProgress }) => {
        void rememberAgent(agentName)
        onProgress(draft.checkout === "new" ? "Preparing worktree..." : "Opening checkout...")
        const result = await prepareCodingCheckout({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          body: {
            id: draft.id,
            project_id: project.id,
            agent_name: agentName,
            main_checkout: draft.checkout === "main",
            worktree_id:
              draft.checkout !== "new" && draft.checkout !== "main" ? draft.checkout : undefined,
            base_ref: draft.checkout === "new" ? draft.baseRef : undefined,
          },
        })
        if (result.error) throw new Error(result.error.message)
        const worktree = result.data
        onProgress("Starting chat...")
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const session = draft.sessionID
          ? await client.session.get({ sessionID: draft.sessionID })
          : await client.session.create({ directory: worktree.directory })
        if (session.error)
          throw new Error(opencodeErrorMessage(session.error, "Could not start the conversation"))
        sessionDrafts.update(scope, draft.id, { sessionID: session.data.id })
        if (draft.checkout === "new" && text && worktree.branch === `chore/${worktree.id}`) {
          try {
            const status = await runWorkspaceGit(workspaceId, worktree.id, {
              operation: "status",
            })
            await startWorkspaceOperation(workspaceId, {
              id: draft.id,
              agent_name: agentName,
              session_id: session.data.id,
              action: "name_branch",
              branch: status.branch,
              expected_head: status.head,
              revision: status.revision,
              text: text.slice(0, 16000),
              model: { modelID: model.modelID, providerID: model.providerID },
            })
          } catch {
            toast.warning("Couldn't name your branch", {
              id: `coding:${draft.id}`,
              description: "You can keep chatting with the current branch name.",
            })
          }
        }
        return session.data
      }}
    />
  )
}
