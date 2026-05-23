"use client"

import { useRouter } from "@bprogress/next/app"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { nanoid } from "nanoid"
import { useCallback, useState } from "react"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { ProviderModelItem } from "@/data/types"
import { createAgentOpencodeClient, createAgentOpencodeClientV2 } from "@/lib/opencode/client"
import {
  attachmentDataFromPart,
  messageHasRenderableContent,
  opencodePartsFromMessage,
} from "@/components/blocks/chat/attachments"
import {
  appendSystemPrompt,
  markOptimisticUserMessageFailed,
  migrateChatOverlay,
  sessionInfoQueryKey,
  sessionMessagesBaseQueryKey,
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

function sdkErrorMessage(error: { data?: { message?: string } } | undefined, fallback: string) {
  return error?.data?.message ?? fallback
}

export function useOpencodeSend(agentName: string, sessionID?: string, isBusy?: boolean) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [pendingSessionID, setPendingSessionID] = useState<string>()
  const activeSessionKey = sessionID ?? "new"
  const sendMutation = useMutation<SendMessageResult, Error, SendMessageInput>({
    mutationFn: async (input) => {
      const text = input.text.trim()
      const message = {
        files: input.files,
        text,
      } satisfies PromptInputMessage
      const parts = opencodePartsFromMessage(message)
      const optimisticAttachments = parts
        .filter(
          (part): part is Extract<(typeof parts)[number], { type: "file" }> => part.type === "file"
        )
        .map(attachmentDataFromPart)

      if (!messageHasRenderableContent(text, optimisticAttachments)) {
        throw new Error("Message cannot be empty")
      }
      if (!input.model) {
        throw new Error("Select a model before sending")
      }
      if (isBusy) {
        throw new Error("Wait for the current run to finish before sending another message")
      }

      const optimisticID = `optimistic-${nanoid()}`
      const createdAt = Date.now()
      upsertOptimisticUserMessage(queryClient, agentName, activeSessionKey, {
        createdAt,
        id: optimisticID,
        kind: "optimistic-user",
        status: "pending",
        attachments: optimisticAttachments,
        text,
      })

      let resolvedSessionID = input.sessionID
      let newSessionDirectory: string | undefined

      try {
        if (!resolvedSessionID) {
          const createClient = createAgentOpencodeClientV2(agentName)
          const createResult = await createClient.session.create({
            model: {
              id: input.model.modelID,
              providerID: input.model.providerID,
              variant: input.variant,
            },
          })
          if (createResult.error || !createResult.data) {
            throw new Error(sdkErrorMessage(createResult.error, "Failed to create session"))
          }

          newSessionDirectory = createResult.data.directory
          resolvedSessionID = createResult.data.id
          setPendingSessionID(createResult.data.id)
          queryClient.setQueryData(
            sessionInfoQueryKey(agentName, createResult.data.id),
            createResult.data
          )
          migrateChatOverlay(queryClient, agentName, "new", createResult.data.id)
          router.replace(`/agents/${agentName}/${createResult.data.id}`)
        }

        const promptClient = createAgentOpencodeClientV2(agentName)
        const promptResult = await promptClient.session.promptAsync({
          model: {
            modelID: input.model.modelID,
            providerID: input.model.providerID,
          },
          parts,
          sessionID: resolvedSessionID,
          variant: input.variant,
        })

        if (promptResult.error) {
          throw new Error(sdkErrorMessage(promptResult.error, "Failed to send message"))
        }

        return {
          directory: newSessionDirectory,
          sessionID: resolvedSessionID,
        }
      } catch (error) {
        const nextSessionKey = resolvedSessionID ?? activeSessionKey
        markOptimisticUserMessageFailed(queryClient, agentName, nextSessionKey, optimisticID)
        appendSystemPrompt(
          queryClient,
          agentName,
          nextSessionKey,
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Failed to send message"
        )
        throw error instanceof Error ? error : new Error("Failed to send message")
      }
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: sessionMessagesBaseQueryKey(agentName, result.sessionID),
      })
    },
  })
  const { error: sendError, isPending: isSendPending, mutateAsync: mutateSendAsync } = sendMutation
  const abortMutation = useMutation<boolean, Error, { sessionID: string; directory?: string }>({
    mutationFn: async (input) => {
      const client = createAgentOpencodeClient(agentName, input.directory)
      const result = await client.session.abort({
        path: {
          id: input.sessionID,
        },
      })

      if (result.error || result.data !== true) {
        throw new Error(sdkErrorMessage(result.error, "Failed to stop the active run"))
      }

      return result.data
    },
    onError: (error, input) => {
      appendSystemPrompt(
        queryClient,
        agentName,
        input.sessionID,
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Failed to stop the active run"
      )
    },
  })
  const { isPending: isAbortPending, mutateAsync: mutateAbortAsync } = abortMutation

  const sendMessage = useCallback(
    async (input: SendMessageInput) => {
      return mutateSendAsync(input)
    },
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
    canSubmit: !isSendPending && !isAbortPending && !isBusy,
    latestError: sendError?.message,
    pendingSessionID,
    sendMessage,
    sendState,
  }
}
