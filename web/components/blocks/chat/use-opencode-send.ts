"use client"

import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { ProviderModelItem } from "@/data/types"
import type { Session } from "@opencode-ai/sdk/v2"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  listChatInputs,
  stopChatInputs,
  submitChatInput,
  updateChatInput,
  type ChatInput,
  type ChatInputRequest,
  type ChatInputs,
  type ChatInputUpdate,
} from "@/lib/gateway/client"
import { uploadChatAttachments } from "./attachments"
import { opencodeErrorMessage } from "./errors"
import { sessionInfoQueryKey } from "./use-opencode-chat"

export type CreateSession = (input: {
  text: string
  model: ProviderModelItem
  onProgress: (status: string) => void
}) => Promise<Session>

type SendMessageInput = PromptInputMessage & {
  agent?: Session["agent"]
  model?: ProviderModelItem
  sessionID?: string
  variant?: string
  delivery: ChatInputRequest["delivery"]
}

export function chatInputsOptions(workspaceId: string, agentName: string, sessionID?: string) {
  return queryOptions({
    queryKey: ["chatInputs", workspaceId, agentName, sessionID] as const,
    enabled: Boolean(sessionID),
    queryFn: async () => {
      if (!sessionID) throw new Error("Chat has not been created")
      const result = await listChatInputs({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName, sessionId: sessionID },
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    // Reconcile even when the browser misses a workspace invalidation.
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  })
}

export function useOpencodeSend(
  agentName: string,
  workspaceId: string,
  sessionID: string | undefined,
  onSessionCreated: ((sessionID: string) => void) | undefined,
  createSession: CreateSession | undefined
) {
  const queryClient = useQueryClient()
  const [pendingSessionID, setPendingSessionID] = useState<string>()
  const resolvedSessionID = sessionID ?? pendingSessionID
  const createdSession = useRef(sessionID)
  const promoted = useRef(Boolean(sessionID))
  const prepared = useRef(new Map<string, { sessionID: string; body: ChatInputRequest }>())
  const submission = useRef<Promise<void>>(Promise.resolve())
  const [pending, setPending] = useState<{ id: string; input: SendMessageInput; status: string }[]>(
    []
  )
  const options = chatInputsOptions(workspaceId, agentName, resolvedSessionID)
  const queueKey = options.queryKey
  const queue = useQuery(options)
  const abort = useMutation({
    mutationKey: ["chatStop", workspaceId, agentName, resolvedSessionID],
    mutationFn: async () => {
      if (!resolvedSessionID) throw new Error("Chat has not been created")
      const result = await stopChatInputs({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName, sessionId: resolvedSessionID },
      })
      if (result.error) throw new Error(result.error.message)
      queryClient.setQueryData(queueKey, result.data)
      return result.data
    },
    onError: (error) => toast.error("Could not stop the run", { description: error.message }),
  })
  const update = useMutation({
    mutationFn: async ({
      item,
      action,
    }: {
      item: ChatInput
      action: ChatInputUpdate["action"]
    }) => {
      if (!resolvedSessionID) throw new Error("Chat has not been created")
      const result = await updateChatInput({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName, sessionId: resolvedSessionID, inputId: item.id },
        body: { revision: item.revision, action },
      })
      if (result.error) throw new Error(result.error.message)
      queryClient.setQueryData<ChatInputs>(
        queueKey,
        (current) =>
          current && {
            ...current,
            items: current.items.flatMap((entry) =>
              entry.id !== item.id ? [entry] : result.data.state === "removed" ? [] : [result.data]
            ),
          }
      )
      return result.data
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queueKey }),
  })
  const send = useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const requestID = input.requestID ?? crypto.randomUUID()
      setPending((current) => [...current, { id: requestID, input, status: "Saving message..." }])
      const previous = submission.current
      const next = Promise.withResolvers<void>()
      submission.current = next.promise
      await previous
      try {
        if (!input.model) throw new Error("Select a model before sending")
        if (!input.text.trim() && !input.files.length) throw new Error("Message cannot be empty")
        let id = input.sessionID ?? createdSession.current
        if (!id) {
          let session: Session
          if (createSession) {
            session = await createSession({
              text: input.text,
              model: input.model,
              onProgress: (status) =>
                setPending((current) =>
                  current.map((item) => (item.id === requestID ? { ...item, status } : item))
                ),
            })
          } else {
            const client = await createAgentOpencodeClient(agentName, workspaceId)
            const result = await client.session.create({
              model: {
                id: input.model.modelID,
                providerID: input.model.providerID,
                variant: input.variant,
              },
            })
            if (result.error)
              throw new Error(opencodeErrorMessage(result.error, "Could not create chat"))
            session = result.data
          }
          id = session.id
          createdSession.current = id
          setPendingSessionID(id)
          queryClient.setQueryData(sessionInfoQueryKey(workspaceId, agentName, id), session)
        }
        setPending((current) =>
          current.map((item) =>
            item.id === requestID ? { ...item, status: "Saving message..." } : item
          )
        )
        let request = prepared.current.get(requestID)
        if (!request) {
          const attachments = await uploadChatAttachments(agentName, workspaceId, id, input.files)
          request = {
            sessionID: id,
            body: {
              id: requestID,
              delivery: input.delivery,
              content: {
                text: input.text.trim(),
                attachments,
                agent: input.agent,
                variant: input.variant,
                model: { modelID: input.model.modelID, providerID: input.model.providerID },
              },
            },
          }
          prepared.current.set(requestID, request)
        }
        const result = await submitChatInput({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: { agentName, sessionId: request.sessionID },
          body: request.body,
        })
        if (result.error) throw new Error(result.error.message)
        prepared.current.delete(requestID)
        queryClient.setQueryData<ChatInputs>(
          chatInputsOptions(workspaceId, agentName, id).queryKey,
          (current) => ({
            stopping: current?.stopping ?? false,
            items: [
              ...(current?.items ?? []).filter((item) => item.id !== result.data.id),
              ...(result.data.state === "delivered" || result.data.state === "removed"
                ? []
                : [result.data]),
            ],
          })
        )
        if (!promoted.current) {
          promoted.current = true
          onSessionCreated?.(id)
        }
      } finally {
        setPending((current) => current.filter((item) => item.id !== requestID))
        next.resolve()
      }
    },
    onError: (error) => toast.error("Message was not saved", { description: error.message }),
  })
  return {
    abortMessage: abort.mutateAsync,
    hasSession: Boolean(resolvedSessionID),
    canSubmit: !abort.isPending && !queue.data?.stopping,
    isStopping: abort.isPending || queue.data?.stopping === true,
    sendMessage: send.mutateAsync,
    pending,
    sendState: pending.length ? ("submitted" as const) : undefined,
    queue: queue.data?.items ?? [],
    queueError: queue.error?.message,
    updateInput: update.mutateAsync,
  }
}
