"use client"

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { Spinner } from "@/components/ui/spinner"
import type { ChatHistoryActionResponse } from "@/data/types"
import { sendMessageMutation } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { useMutation } from "@tanstack/react-query"
import { Bot } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import { mergeChatMessages } from "./history"
import { MessagePart } from "./message-parts"
import { useChatHistory } from "./use-chat-history"
import { useSessionStream } from "./use-session-stream"
import type { ChatMessage } from "./types"

const emptyMessages: ChatMessage[] = []

type ActiveRequest = {
  requestID: string
  sessionID: string
}

type ChatProps = {
  id: string
  initialHistory: ChatHistoryActionResponse
  initialHistoryLimit: number
}

type FetchOlderMessages = () => Promise<void>

export default function Chat({ id, initialHistory, initialHistoryLimit }: ChatProps) {
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([])
  const [activeRequests, setActiveRequests] = useState<ActiveRequest[]>([])
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const stream = useSessionStream(id)
  const send = useMutation(sendMessageMutation())
  const { error, isPending, mutateAsync } = send
  const history = useChatHistory({
    initialData: initialHistory.data,
    limit: initialHistoryLimit,
    sessionID: id,
  })
  const {
    error: historyError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    messages: historyMessages,
  } = history
  const streamMessages = stream.data ?? emptyMessages
  const historyRequestIDs = useMemo(() => {
    return new Set(historyMessages.map((message) => message.requestID))
  }, [historyMessages])
  const newStreamMessages = useMemo(() => {
    return streamMessages.filter((message) => !historyRequestIDs.has(message.requestID))
  }, [historyRequestIDs, streamMessages])
  const streamRequestIDs = useMemo(() => {
    return new Set(newStreamMessages.map((message) => message.requestID))
  }, [newStreamMessages])
  const displayedRequestIDs = useMemo(() => {
    return new Set([...historyRequestIDs, ...streamRequestIDs])
  }, [historyRequestIDs, streamRequestIDs])
  const activeStreamMessage = streamMessages.find((message) => message.status === "streaming")
  const activePendingMessage = pendingMessages.find((message) => {
    return !displayedRequestIDs.has(message.requestID)
  })
  const completedRequestIDs = useMemo(() => {
    return new Set(
      [...historyMessages, ...streamMessages]
        .filter((message) => {
          return message.role === "assistant" && message.status !== "streaming"
        })
        .map((message) => message.requestID)
    )
  }, [historyMessages, streamMessages])
  const hasActiveRequest = activeRequests.some((request) => {
    return request.sessionID === id && !completedRequestIDs.has(request.requestID)
  })
  const visibleMessages = useMemo(() => {
    const nextPendingMessages = pendingMessages.filter((message) => {
      return !displayedRequestIDs.has(message.requestID)
    })

    return mergeChatMessages(historyMessages, newStreamMessages, nextPendingMessages)
  }, [displayedRequestIDs, historyMessages, newStreamMessages, pendingMessages])
  const isWaiting = isPending || Boolean(activePendingMessage) || hasActiveRequest
  const isWorking = isWaiting || Boolean(activeStreamMessage)
  const submitStatus = isPending ? "submitted" : activeStreamMessage ? "streaming" : "ready"
  const fetchOlderMessages = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage) {
      return
    }

    await fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  useEffect(() => {
    if (isWorking) {
      return
    }

    promptRef.current?.focus()
  }, [isWorking, visibleMessages.length])

  const handleSubmit = useCallback(
    async ({ text }: { text: string }) => {
      const prompt = text.trim()
      if (!prompt || isWorking) {
        return
      }

      const optimisticID = `pending:${Date.now()}`
      setPendingMessages((messages) => [
        ...messages,
        {
          id: optimisticID,
          content: prompt,
          parts: [{ id: `${optimisticID}:text`, content: prompt, type: "text" }],
          requestID: optimisticID,
          role: "user",
          runID: optimisticID,
          status: "complete",
        },
      ])

      try {
        const result = await mutateAsync({
          body: { prompt, session_id: id },
        })

        setActiveRequests((requests) => {
          return [...requests, { requestID: result.request_id, sessionID: id }]
        })
        setPendingMessages((messages) => {
          return messages.map((message) => {
            if (message.requestID !== optimisticID) {
              return message
            }

            return {
              ...message,
              id: `${result.request_id}:user`,
              requestID: result.request_id,
              runID: result.run_id,
            }
          })
        })
      } catch (error) {
        setPendingMessages((messages) => {
          return messages.filter((message) => message.requestID !== optimisticID)
        })
        throw error
      }
    },
    [id, isWorking, mutateAsync]
  )

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <Conversation className="w-full">
        <ConversationContent className="mx-auto w-full max-w-4xl px-4 pt-0 pb-4">
          <SubmittedMessageScroller messageID={pendingMessages.at(-1)?.id} />
          <HistoryPaginationTrigger
            canLoadMore={Boolean(hasNextPage)}
            isLoading={isFetchingNextPage}
            messageCount={visibleMessages.length}
            onLoadMore={fetchOlderMessages}
          />
          {visibleMessages.length === 0 ? (
            <ConversationEmptyState
              description="Type a message below to begin"
              icon={<Bot className="size-12" />}
              title="Start a conversation"
            />
          ) : (
            visibleMessages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part) => (
                    <MessagePart key={part.id} part={part} />
                  ))}
                </MessageContent>
              </Message>
            ))
          )}
          <ConversationScrollButton />
        </ConversationContent>
      </Conversation>
      {historyError || initialHistory.error ? (
        <p
          className="mx-auto mt-2 w-[calc(100%-2rem)] max-w-4xl rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {historyError?.message ?? initialHistory.error?.message}
        </p>
      ) : null}
      <PromptInput
        className="relative mx-auto my-4 w-[calc(100%-2rem)] max-w-4xl"
        onSubmit={handleSubmit}
      >
        <PromptInputTextarea
          autoFocus
          className="pr-14"
          disabled={isWorking}
          placeholder={isWorking ? "Agent is thinking..." : "Say something..."}
          ref={promptRef}
        />
        <PromptInputSubmit
          className="absolute right-1 bottom-1"
          disabled={isWorking}
          status={submitStatus}
        />
      </PromptInput>
      {error ? (
        <p
          className="mx-auto mt-2 w-[calc(100%-2rem)] max-w-4xl rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error.message}
        </p>
      ) : null}
    </div>
  )
}

function SubmittedMessageScroller({ messageID }: { messageID?: string }) {
  const { scrollToBottom } = useStickToBottomContext()
  const lastMessageID = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!messageID || lastMessageID.current === messageID) {
      return
    }

    lastMessageID.current = messageID
    void scrollToBottom({
      animation: "smooth",
      ignoreEscapes: true,
    })
  }, [messageID, scrollToBottom])

  return null
}

function HistoryPaginationTrigger({
  canLoadMore,
  isLoading,
  messageCount,
  onLoadMore,
}: {
  canLoadMore: boolean
  isLoading: boolean
  messageCount: number
  onLoadMore: FetchOlderMessages
}) {
  const context = useStickToBottomContext()
  const restoreScrollHeight = useRef<number | null>(null)

  useEffect(() => {
    const scroll = context.scrollRef.current
    if (!scroll || !canLoadMore || isLoading) {
      return
    }

    if (scroll.scrollHeight < scroll.clientHeight * 2) {
      restoreScrollHeight.current = scroll.scrollHeight
      void onLoadMore()
    }
  }, [canLoadMore, context.scrollRef, isLoading, messageCount, onLoadMore])

  useEffect(() => {
    const scroll = context.scrollRef.current
    if (!scroll || !canLoadMore || isLoading) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          restoreScrollHeight.current = scroll.scrollHeight
          void onLoadMore()
        }
      },
      { root: scroll, rootMargin: "240px 0px 0px 0px" }
    )
    const sentinel = context.contentRef.current?.firstElementChild
    if (sentinel) {
      observer.observe(sentinel)
    }

    return () => observer.disconnect()
  }, [canLoadMore, context.contentRef, context.scrollRef, isLoading, onLoadMore])

  useLayoutEffect(() => {
    const previousHeight = restoreScrollHeight.current
    if (previousHeight === null) {
      return
    }

    restoreScrollHeight.current = null
    const frame = window.requestAnimationFrame(() => {
      const scroll = context.scrollRef.current
      if (!scroll) {
        return
      }

      scroll.scrollTo({ top: scroll.scrollTop + scroll.scrollHeight - previousHeight })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [context.scrollRef, messageCount])

  return (
    <div className="flex h-0 items-center justify-center overflow-visible">
      {isLoading ? (
        <Spinner className="animate-in fade-in-0 text-muted-foreground delay-300 duration-150" />
      ) : null}
    </div>
  )
}
