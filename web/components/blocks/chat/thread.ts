"use client"

import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { toast } from "sonner"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  getChatSessionState,
  watchChatSessions,
  type WatchChatSessionsEvent,
  updateChatSession,
  type ChatSessionState,
  type UpdateChatSessionRequest,
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

export function useThreadMutation(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  userId: string,
  state: ChatSessionState | undefined
) {
  const queryClient = useQueryClient()
  const options = threadStateOptions(workspaceId, agentName, sessionId, userId)
  return useMutation({
    mutationFn: async (change: Pick<UpdateChatSessionRequest, "pinned" | "locked">) => {
      if (!state) throw new Error("Wait for this chat to load")
      const result = await updateChatSession({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName, sessionId },
        body: { ...change, expected_version: state.version },
      })
      if (result.error) throw new Error(result.error.message)
    },
    onError: (error) => toast.error(error.message),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: options.queryKey }),
        queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "chatSessions" && query.queryKey[1] === workspaceId,
        }),
      ])
    },
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
