import { queryOptions } from "@tanstack/react-query"
import { runBrowser } from "@/lib/gateway/client"

export function browserQueryOptions(workspaceId: string, agentName: string, sessionId?: string) {
  return queryOptions({
    queryKey: ["browser", workspaceId, agentName, sessionId],
    queryFn: async ({ signal }) => {
      if (!sessionId) throw new Error("Session is required")
      const { data } = await runBrowser({
        path: { agentName, sessionId },
        body: { operation: "status" },
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        signal,
        throwOnError: true,
      })
      return data
    },
    retry: false,
  })
}
