"use server"

import { getGuardrailEvent, getWorkspace } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { getSpanDetailAction } from "@/data/lens.actions"

/** Read the correlated operation through its workspace's Lens permissions. */
export async function getGuardrailEventContextAction(eventId: string, workspaceId?: string) {
  const result = await getGuardrailEvent({
    path: { eventId },
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }
  const source = result.data.trace_source
  const sourceWorkspaceId = source?.workspace_id || result.data.workspace_id
  if (!sourceWorkspaceId)
    return {
      error: {
        code: "not_found",
        message: "No accessible model call could be matched to this evaluation.",
      },
    }
  const [workspace, span] = await Promise.all([
    getWorkspace({
      path: { workspaceId: sourceWorkspaceId },
      client: getGatewayServerClient(sourceWorkspaceId),
    }),
    source
      ? getSpanDetailAction(
          {
            subject: source.agent_name
              ? { kind: "agent", name: source.agent_name, sessionId: source.session_id }
              : {
                  kind: "app",
                  clientID: source.client_id,
                  name: result.data.subject_name || source.client_id,
                },
            traceID: source.trace_id,
            spanID: source.span_id,
            operationID: source.operation_id,
          },
          sourceWorkspaceId
        )
      : undefined,
  ])
  if (workspace.error) return { error: workspace.error }
  return {
    data: {
      source,
      workspaceSlug: workspace.data.slug,
      workspaceName: workspace.data.name,
      span: span?.data,
      contentError: source
        ? span?.error?.message
        : "No accessible model call could be matched to this evaluation.",
    },
  }
}
