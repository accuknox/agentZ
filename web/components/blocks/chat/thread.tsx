"use client"

import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { LockKeyhole, LockKeyholeOpen, Pin, PinOff } from "lucide-react"
import { useEffect } from "react"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { authClient } from "@/lib/auth-client"
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

export function ThreadControls({
  workspaceId,
  agentName,
  sessionId,
  coding,
}: {
  workspaceId: string
  agentName: string
  sessionId: string
  coding: boolean
}) {
  const { data: actor } = authClient.useSession()
  const userId = actor?.user.id ?? ""
  const queryClient = useQueryClient()
  const watch = useQuery({
    ...chatSessionWatchOptions(workspaceId, userId),
    enabled: userId !== "",
  })
  const thread = useQuery(threadStateOptions(workspaceId, agentName, sessionId, userId))
  useEffect(() => {
    if (!watch.data) return
    const queryKey = threadStateOptions(workspaceId, agentName, sessionId, userId).queryKey
    void queryClient
      .cancelQueries({ queryKey })
      .then(() => queryClient.invalidateQueries({ queryKey }))
  }, [queryClient, workspaceId, agentName, sessionId, userId, watch.data])
  const mutation = useThreadMutation(workspaceId, agentName, sessionId, userId, thread.data)
  const state = thread.data
  const pinned = state !== undefined && (state.pinned || (state.locked && state.is_participant))
  const pinLabel = pinned ? "Unpin chat for everyone" : "Pin chat for everyone"
  const lockLabel = state?.locked ? "Unlock chat" : "Lock chat"
  const actorName = state?.actor?.name || state?.actor?.email
  return (
    <div className="flex items-center gap-1" aria-busy={mutation.isPending}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={pinLabel}
              aria-pressed={pinned}
              className="text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
              disabled={!state || (state.locked && pinned) || mutation.isPending}
              onClick={() => mutation.mutate({ pinned: !state?.pinned })}
            >
              {pinned ? <PinOff /> : <Pin />}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {state?.locked && pinned ? "Unlock this chat before unpinning it" : pinLabel}
        </TooltipContent>
      </Tooltip>
      {!coding ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={lockLabel}
              aria-pressed={state?.locked ?? false}
              className="text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
              disabled={!state || mutation.isPending}
              onClick={() => mutation.mutate({ locked: !state?.locked })}
            >
              {state?.locked ? <LockKeyhole /> : <LockKeyholeOpen />}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <p>{lockLabel}</p>
            {state?.locked ? (
              <p className="text-xs opacity-75">
                {actorName ? `Locked by ${actorName}. ` : ""}Only participants can send messages.
                Automatically pinned for participants.
              </p>
            ) : (
              <p className="text-xs opacity-75">Prevent deletion and new participants.</p>
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {state?.locked ? "Chat locked" : ""}
      </span>
    </div>
  )
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
