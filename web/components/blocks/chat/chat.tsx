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
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Spinner } from "@/components/ui/spinner"
import type { ChatHistoryActionResponse } from "@/data/types"
import { sessionPromptMutation } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { useMutation } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import { mergeChatMessages } from "./history"
import { MessagePart } from "./message-parts"
import { useChatHistory } from "./use-chat-history"
import type { ChatMessage } from "./types"

type ChatProps = {
  id: string
  initialHistory: ChatHistoryActionResponse
  initialHistoryLimit: number
}

type FetchOlderMessages = () => Promise<void>

export default function Chat({ id, initialHistory, initialHistoryLimit }: ChatProps) {
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([])
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const send = useMutation(sessionPromptMutation())
  const { error, isPending, mutateAsync } = send
  const history = useChatHistory({
    agentName: id,
    initialData: initialHistory.data,
    limit: initialHistoryLimit,
  })
  const {
    error: historyError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    messages: historyMessages,
    refetch,
  } = history
  const historyRequestIDs = useMemo(() => {
    return new Set(historyMessages.map((message) => message.requestID))
  }, [historyMessages])
  const activePendingMessage = pendingMessages.find((message) => {
    return !historyRequestIDs.has(message.requestID)
  })
  const visibleMessages = useMemo(() => {
    const nextPendingMessages = pendingMessages.filter((message) => {
      return !historyRequestIDs.has(message.requestID)
    })

    return mergeChatMessages(historyMessages, nextPendingMessages)
  }, [historyMessages, historyRequestIDs, pendingMessages])
  const isWorking = isPending || Boolean(activePendingMessage)
  const submitStatus = isPending ? "submitted" : "ready"
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
        await mutateAsync({
          body: {
            parts: [{ text: prompt, type: "text" }],
          },
          path: {
            agentName: id,
            sessionID: id,
          },
        })

        setPendingMessages((messages) => {
          return messages.filter((message) => message.requestID !== optimisticID)
        })
        await refetch()
      } catch (error) {
        setPendingMessages((messages) => {
          return messages.filter((message) => message.requestID !== optimisticID)
        })
      }
    },
    [id, isWorking, mutateAsync, refetch]
  )

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      <Conversation className="w-full">
        <ConversationContent className="w-full gap-3 px-3 pt-0 pb-8 md:px-4">
          <SubmittedMessageScroller messageID={pendingMessages.at(-1)?.id} />
          <HistoryPaginationTrigger
            canLoadMore={Boolean(hasNextPage)}
            isLoading={isFetchingNextPage}
            messageCount={visibleMessages.length}
            onLoadMore={fetchOlderMessages}
          />
          {visibleMessages.length === 0 ? (
            <ConversationEmptyState
              className="min-h-[40svh]"
              description="Type below to begin"
              title="Start a conversation"
            />
          ) : (
            visibleMessages.map((message) => (
              <Message from={message.role} key={message.id} tone={getMessageTone(message)}>
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
        <TranscriptAlert>{historyError?.message ?? initialHistory.error?.message}</TranscriptAlert>
      ) : null}
      <ComposerActivity active={isWorking} />
      <PromptInput className="relative w-full" onSubmit={handleSubmit}>
        <PromptInputTextarea
          autoFocus
          disabled={isWorking}
          placeholder={isWorking ? "Working..." : "Message"}
          ref={promptRef}
        />
        <PromptInputSubmit
          className="absolute right-3 bottom-3"
          disabled={isWorking}
          variant="ghost"
          status={submitStatus}
        />
      </PromptInput>
      {error ? <TranscriptAlert>Request failed</TranscriptAlert> : null}
    </div>
  )
}

function getMessageTone(message: ChatMessage) {
  if (message.role === "user") {
    return "user"
  }
  if (message.status === "streaming") {
    return "active"
  }
  if (message.status === "error") {
    return "error"
  }
  if (message.status === "interrupted") {
    return "interrupted"
  }
  return "neutral"
}

function TranscriptAlert({ children }: { children: ReactNode }) {
  return (
    <p
      className="border-l-2 border-chat-error px-2.5 py-3 font-mono text-sm text-destructive"
      role="alert"
    >
      {children}
    </p>
  )
}

function ComposerActivity({ active }: { active: boolean }) {
  if (!active) {
    return null
  }

  return (
    <div className="flex h-6 items-center px-3 font-mono text-sm md:px-4">
      <Shimmer active={active} className="text-chat-user" duration={1}>
        ........
      </Shimmer>
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
