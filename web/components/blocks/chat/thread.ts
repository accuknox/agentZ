"use client"

import { experimental_streamedQuery as streamedQuery, queryOptions } from "@tanstack/react-query"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  getChatSessionState,
  watchChatSessions,
  type WatchChatSessionsEvent,
} from "@/lib/gateway/client"

export function threadStateOptions(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  userId: string
) {
  return queryOptions({
    queryKey: ["chatSessionState", workspaceId, agentName, sessionId, userId],
    queryFn: async ({ signal }) => {
      const result = await getChatSessionState({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName, sessionId },
        signal,
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    enabled: Boolean(sessionId && userId),
    staleTime: Infinity,
  })
}

export function chatSessionWatchOptions(workspaceId: string, userId: string) {
  return queryOptions({
    queryKey: ["watchChatSessions", workspaceId, userId],
    queryFn: streamedQuery<WatchChatSessionsEvent, number, ["watchChatSessions", string, string]>({
      initialValue: 0,
      refetchMode: "append",
      reducer: (revision) => revision + 1,
      streamFn: async function* ({ signal, client }) {
        const result = await watchChatSessions({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
        })
        for await (const event of result.stream) {
          const queryKey = ["chatSessionState", workspaceId]
          void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }))
          if (event.revision === "0") {
            void client.invalidateQueries({
              queryKey: watchAgentsQueryOptions(workspaceId).queryKey,
            })
          }
          yield event
        }
        if (!signal.aborted) throw new Error("Chat session watch closed")
      },
    }),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })
}
