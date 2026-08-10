import { cacheLife, cacheTag } from "next/cache"
import { workflowRunsTag } from "@/data/cache"
import { listWorkflowWebhookTriggers } from "@/lib/gateway/client"
import type {
  Error,
  ListWorkflowWebhookTriggersData,
  WorkflowWebhookTrigger,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type ListWorkflowWebhookTriggersQueryResult =
  | {
      webhookTriggers: WorkflowWebhookTrigger[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      webhookTriggers: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export async function listWorkflowWebhookTriggersCachedQuery(
  agentName: ListWorkflowWebhookTriggersData["path"]["agentName"],
  workspaceId: string,
  query?: ListWorkflowWebhookTriggersData["query"]
): Promise<ListWorkflowWebhookTriggersQueryResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(workflowRunsTag, `${workflowRunsTag}:${workspaceId}`)

  const { data, error } = await listWorkflowWebhookTriggers({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { agentName },
    query,
  })
  if (error) {
    return {
      webhookTriggers: undefined,
      error,
    }
  }

  const webhookTriggers = data.webhook_triggers
  const nextPageToken = data.next_page_token

  return {
    webhookTriggers,
    nextPageToken,
    hasNextPage: nextPageToken.length > 0,
    error: undefined,
  }
}
