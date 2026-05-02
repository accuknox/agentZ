import { subscribeSession, type SubscribeSessionResponse } from "@/lib/gateway/client"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query"

import { reduceSessionEvent } from "./transcript"
import type { ChatMessage } from "./types"

type SubscribeSessionQueryKey = ["subscribeSession", string]

export function useSessionStream(sessionID: string): UseQueryResult<ChatMessage[], Error> {
  return useQuery(
    queryOptions({
      queryFn: streamedQuery<SubscribeSessionResponse, ChatMessage[], SubscribeSessionQueryKey>({
        initialValue: [],
        refetchMode: "append",
        reducer: (messages, event) => {
          return reduceSessionEvent(messages, event)
        },
        streamFn: async ({ signal }) => {
          const result = await subscribeSession({
            body: { session_id: sessionID },
            sseDefaultRetryDelay: 1_000,
            sseMaxRetryDelay: 30_000,
            signal,
          })
          return reconnectOnClose(result.stream, signal)
        },
      }),
      queryKey: ["subscribeSession", sessionID],
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: (_failureCount, error) => !isAbortError(error),
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
      staleTime: Infinity,
    })
  )
}

async function* reconnectOnClose(
  stream: AsyncIterable<SubscribeSessionResponse>,
  signal: AbortSignal
): AsyncGenerator<SubscribeSessionResponse> {
  for await (const event of stream) {
    yield event
  }

  if (!signal.aborted) {
    throw new Error("SSE stream closed")
  }
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError"
}
