"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
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
  createCodingThread,
  updateCodingProjectPreference,
  type CodingProject,
  type ChatSessionPreference,
} from "@/lib/gateway/client"
import { runWorkspaceGit, startWorkspaceOperation } from "@/lib/coding/review"
import { CheckoutPicker } from "./projects"
import { codingDrafts, useCodingDrafts, type CodingDraft } from "./drafts"

export function CodingChat({
  project,
  agentNames,
  chatPreferences,
  workspaceId,
  workspacePath,
}: {
  project: CodingProject
  agentNames: string[]
  chatPreferences: ChatSessionPreference
  workspaceId: string
  workspacePath: `/orgs/${string}/workspaces/${string}`
}) {
  const { data: actor } = authClient.useSession()
  const scope = actor ? `${actor.user.id}:${workspaceId}` : ""
  const drafts = useCodingDrafts(scope)
  const search = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const id = search.get("draft")
  const [promoted, setPromoted] = useState<CodingDraft>()
  const draft = drafts.find((item) => item.id === id && item.projectId === project.id) ?? promoted
  const [ready, setReady] = useState(false)
  const selected =
    [
      search.get("agent"),
      project.last_agent_name,
      chatPreferences.last_agent_name,
      agentNames[0],
    ].find((name) => name && agentNames.includes(name)) ?? ""
  useEffect(() => {
    if (!scope || !selected || promoted) return
    let active = true
    void codingDrafts
      .load(scope)
      .catch(() => [])
      .then(async (saved) => {
        if (!active) return
        setReady(true)
        if (saved.some((item) => item.id === id && item.projectId === project.id)) return
        const created = await codingDrafts.start(scope, project.id, selected)
        if (!active) return
        router.replace(
          `${workspacePath}/sessions/new?${new URLSearchParams({ project: project.id, draft: created.id })}`
        )
      })
    return () => {
      active = false
    }
  }, [scope, selected, id, promoted, project.id, router, workspacePath])
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
      <div className="text-muted-foreground m-auto p-6 text-sm">
        No agent is available. Ask a workspace administrator for access.
      </div>
    )
  if (!ready || !draft)
    return (
      <div
        role="status"
        className="text-muted-foreground m-auto flex items-center gap-2 p-6 text-sm"
      >
        <Spinner /> Preparing chat…
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
      draftPath={`${workspacePath}/sessions/new`}
      workspaceId={workspaceId}
      workspacePath={workspacePath}
      initialMessage={draft.message}
      draftModel={draft.model}
      onDraftModelChange={(model) => codingDrafts.save({ ...draft, model })}
      onDraftChange={promoted ? undefined : (message) => codingDrafts.save({ ...draft, message })}
      onDraftPromoted={() => {
        setPromoted(draft)
        codingDrafts.remove(scope, draft.id)
      }}
      onDraftAgentChange={(name) => {
        codingDrafts.save({ ...draft, agentName: name, checkout: "new", baseRef: undefined })
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
            codingDrafts.save({ ...draft, checkout: value, baseRef: ref })
          }}
        />
      )}
      createSession={async ({ text, model }) => {
        await rememberAgent(agentName)
        const result = await createCodingThread({
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
        const thread = result.data
        if (
          draft.checkout === "new" &&
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
  )
}
