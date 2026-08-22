"use client"

import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { ProviderModelItem } from "@/data/types"
import type { SessionStatus, SessionStatusResponse } from "@opencode-ai/sdk/v2"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { dayjs } from "@/lib/format"
import {
  opencodePartsFromMessage,
  uploadChatAttachments,
} from "@/components/blocks/chat/attachments"
import { opencodeErrorMessage } from "@/components/blocks/chat/errors"
import {
  markOptimisticUserMessageFailed,
  promoteChatOverlay,
  sessionInfoQueryKey,
  sessionStatusQueryOptions,
  upsertOptimisticUserMessage,
} from "@/components/blocks/chat/use-opencode-chat"

type SendMessageInput = {
  files: PromptInputMessage["files"]
  model?: ProviderModelItem
  sessionID?: string
  text: string
  variant?: string
}

type SendMessageResult = {
  directory?: string
  sessionID: string
}

let lastMessageTimestamp = 0
let messageCounter = 0

function createMessageID() {
  const timestamp = dayjs().valueOf()
  messageCounter = timestamp === lastMessageTimestamp ? messageCounter + 1 : 1
  lastMessageTimestamp = timestamp

  // OpenCode sorts msg_* IDs lexicographically, so match its full ascending
  // ID format: a 48-bit timestamp/counter followed by 14 random base-62 bytes.
  const time = (BigInt(timestamp) * 0x1000n + BigInt(messageCounter)) & 0xffffffffffffn
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  const random = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
  return `msg_${time.toString(16).padStart(12, "0")}${random}`
}

export function useOpencodeSend(
  agentName: string,
  workspaceId: string,
  sessionID?: string,
  draftID?: string,
  directory?: string,
  isBusy?: boolean,
  onSessionCreated?: (sessionID: string) => void
) {
  const queryClient = useQueryClient()
  const [pendingSessionID, setPendingSessionID] = useState<string>()
  const abortKey = ["opencode", "sessionAbort", agentName] as const
  const abortMutation = useMutation<boolean, Error, { sessionID: string; directory?: string }>({
    mutationKey: abortKey,
    mutationFn: async (input) => {
      const client = await createAgentOpencodeClient(agentName, workspaceId)
      const result = await client.session.abort({
        ...(input.directory ? { directory: input.directory } : {}),
        sessionID: input.sessionID,
      })

      if (result.error || result.data !== true) {
        throw new Error(opencodeErrorMessage(result.error, "Failed to stop the active run"))
      }

      const deadline = dayjs().add(10, "seconds")
      while (dayjs().isBefore(deadline)) {
        const status = await client.session.status({ directory: input.directory })
        if (status.error || !status.data) {
          throw new Error(opencodeErrorMessage(status.error, "Failed to confirm the run stopped"))
        }

        const sessionStatus = status.data[input.sessionID]
        if (!sessionStatus || sessionStatus.type === "idle") {
          await new Promise((resolve) => setTimeout(resolve, 2_000))
          queryClient.setQueryData<SessionStatusResponse>(
            sessionStatusQueryOptions(agentName, workspaceId, input.directory ?? "").queryKey,
            (current) => ({
              ...current,
              [input.sessionID]: { type: "idle" },
            })
          )
          return result.data
        }

        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      throw new Error("The agent did not become idle after stopping. Reload before sending again.")
    },
    onError: (error) => {
      toast.error("Failed to stop the active run", { description: error.message })
    },
  })
  const isStopping = useIsMutating({ mutationKey: abortKey }) > 0
  const sendMutation = useMutation<SendMessageResult, Error, SendMessageInput>({
    mutationFn: async (input) => {
      const text = input.text.trim()

      if (text.length === 0 && input.files.length === 0) {
        throw new Error("Message cannot be empty")
      }
      if (!input.model) {
        throw new Error("Select a model before sending")
      }
      if (isBusy || isStopping) {
        throw new Error("Wait for the current run to finish before sending another message")
      }

      const pendingID = createMessageID()
      const createdAt = dayjs().valueOf()
      let overlayID = input.sessionID ?? draftID
      upsertOptimisticUserMessage(queryClient, workspaceId, agentName, overlayID, {
        attachments: [],
        createdAt,
        id: pendingID,
        status: "pending",
        text,
      })

      let resolvedSessionID = input.sessionID
      let sessionDirectory = directory
      let optimisticStatus: { sessionID: string; value: SessionStatus } | undefined

      try {
        const client = await createAgentOpencodeClient(agentName, workspaceId)

        if (!resolvedSessionID) {
          const createResult = await client.session.create({
            model: {
              id: input.model.modelID,
              providerID: input.model.providerID,
              variant: input.variant,
            },
          })
          if (createResult.error || !createResult.data) {
            throw new Error(opencodeErrorMessage(createResult.error, "Failed to create session"))
          }

          sessionDirectory = createResult.data.directory
          resolvedSessionID = createResult.data.id
          setPendingSessionID(createResult.data.id)
          queryClient.setQueryData(
            sessionInfoQueryKey(workspaceId, agentName, createResult.data.id),
            createResult.data
          )
          promoteChatOverlay(queryClient, workspaceId, agentName, overlayID, createResult.data.id)
          overlayID = createResult.data.id
          onSessionCreated?.(createResult.data.id)
        }

        const activeSessionID = resolvedSessionID
        const uploaded = await uploadChatAttachments(
          agentName,
          workspaceId,
          activeSessionID,
          input.files
        )
        const parts = opencodePartsFromMessage(text, uploaded)
        const pendingStatus: SessionStatus = { type: "busy" }
        optimisticStatus = { sessionID: activeSessionID, value: pendingStatus }
        const sessionStatusOptions = sessionStatusQueryOptions(
          agentName,
          workspaceId,
          sessionDirectory ?? ""
        )
        queryClient.setQueryData<SessionStatusResponse>(
          sessionStatusOptions.queryKey,
          (current) => ({
            ...current,
            [activeSessionID]: pendingStatus,
          })
        )
        upsertOptimisticUserMessage(queryClient, workspaceId, agentName, activeSessionID, {
          attachments: uploaded,
          createdAt,
          id: pendingID,
          status: "pending",
          text,
        })

        const promptResult = await client.session.promptAsync({
          messageID: pendingID,
          model: {
            modelID: input.model.modelID,
            providerID: input.model.providerID,
          },
          parts,
          sessionID: activeSessionID,
          variant: input.variant,
        })

        if (promptResult.error) {
          throw new Error(opencodeErrorMessage(promptResult.error, "Failed to send message"))
        }

        return {
          directory: sessionDirectory,
          sessionID: activeSessionID,
        }
      } catch (error) {
        markOptimisticUserMessageFailed(queryClient, workspaceId, agentName, overlayID, pendingID)
        if (optimisticStatus) {
          const { sessionID: failedSessionID, value: failedStatus } = optimisticStatus
          queryClient.setQueryData<SessionStatusResponse>(
            sessionStatusQueryOptions(agentName, workspaceId, sessionDirectory ?? "").queryKey,
            (current) => {
              if (current?.[failedSessionID] !== failedStatus) return current
              return { ...current, [failedSessionID]: { type: "idle" } }
            }
          )
        }
        throw error
      }
    },
    onError: (error) => {
      toast.error("Failed to send message", { description: error.message })
    },
    // No refetch here: promptAsync resolves at turn start, so a GET now can
    // resolve after the terminal events and clobber the live store with a
    // pre-completion snapshot, hanging at "Working". The stream is the source
    // of truth after load.
  })
  const { isPending: isSendPending, mutateAsync: mutateSendAsync } = sendMutation
  const { mutateAsync: mutateAbortAsync } = abortMutation

  const sendMessage = useCallback(
    (input: SendMessageInput) => mutateSendAsync(input),
    [mutateSendAsync]
  )

  const abortMessage = useCallback(
    async (directory?: string) => {
      const resolvedSessionID = sessionID ?? pendingSessionID
      if (!resolvedSessionID) return
      await mutateAbortAsync({ directory, sessionID: resolvedSessionID })
    },
    [mutateAbortAsync, pendingSessionID, sessionID]
  )
  const sendState: "submitted" | undefined = isSendPending ? "submitted" : undefined

  return {
    abortMessage,
    canSubmit: !isSendPending && !isStopping && !isBusy,
    isStopping,
    sendMessage,
    sendState,
  }
}
