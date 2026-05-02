"use client"

import { getChatHistory, type ChatHistoryResponse } from "@/lib/gateway/client"
import { infiniteQueryOptions, useInfiniteQuery, type InfiniteData } from "@tanstack/react-query"
import { useMemo } from "react"

import { chatHistoryToMessages } from "./history"

type UseChatHistoryParams = {
  initialData?: ChatHistoryResponse
  limit: number
  sessionID: string
}

export function useChatHistory({ initialData, limit, sessionID }: UseChatHistoryParams) {
  const queryInitialData = useMemo(() => {
    if (!initialData) {
      return undefined
    }

    return {
      pageParams: [undefined],
      pages: [initialData],
    } satisfies InfiniteData<ChatHistoryResponse, string | undefined>
  }, [initialData])
  const query = useInfiniteQuery(
    chatHistoryOptions({
      initialData: queryInitialData,
      limit,
      sessionID,
    })
  )
  const messages = useMemo(() => {
    return chatHistoryToMessages(query.data?.pages ?? [])
  }, [query.data?.pages])

  return {
    error: query.error,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    messages,
  }
}

function chatHistoryOptions({
  initialData,
  limit,
  sessionID,
}: {
  initialData?: InfiniteData<ChatHistoryResponse, string | undefined>
  limit: number
  sessionID: string
}) {
  return infiniteQueryOptions({
    queryKey: ["chatHistory", sessionID, limit],
    queryFn: async ({ pageParam, signal }) => {
      const query =
        pageParam === undefined
          ? { limit, session_id: sessionID }
          : { limit, page_token: pageParam, session_id: sessionID }
      const { data } = await getChatHistory({
        query,
        signal,
        throwOnError: true,
      })

      return data
    },
    initialData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_page_token || undefined,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
}
