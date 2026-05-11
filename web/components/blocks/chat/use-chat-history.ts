"use client"

import { infiniteQueryOptions, useInfiniteQuery, type InfiniteData } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  sessionMessages,
  type SessionMessagesData,
  type SessionMessagesResponse,
} from "@/lib/gateway/client"

import { chatHistoryToMessages } from "./history"

type UseChatHistoryParams = {
  initialData?: SessionMessagesResponse
  limit: number
  agentName: string
}

export function useChatHistory({ initialData, limit, agentName }: UseChatHistoryParams) {
  const queryInitialData = useMemo(() => {
    if (!initialData) {
      return undefined
    }

    return {
      pageParams: [undefined],
      pages: [initialData],
    } satisfies InfiniteData<SessionMessagesResponse, string | undefined>
  }, [initialData])
  const query = useInfiniteQuery(
    chatHistoryOptions({
      agentName,
      initialData: queryInitialData,
      limit,
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
    refetch: query.refetch,
  }
}

function chatHistoryOptions({
  agentName,
  initialData,
  limit,
}: {
  agentName: string
  initialData?: InfiniteData<SessionMessagesResponse, string | undefined>
  limit: number
}) {
  return infiniteQueryOptions({
    queryKey: ["chatHistory", agentName, limit],
    queryFn: async ({ pageParam, signal }) => {
      const query: SessionMessagesData["query"] = {
        before: pageParam,
        limit,
      }
      const { data } = await sessionMessages({
        path: {
          agentName,
          sessionID: agentName,
        },
        query,
        signal,
        throwOnError: true,
      })

      return data
    },
    initialData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.at(-1)?.info.id,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
}
