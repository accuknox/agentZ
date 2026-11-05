"use server"

import { updateTag } from "next/cache"
import { agentWorkflowsTag, workflowTag } from "@/data/cache"
import { setWorkflowLock, type SetWorkflowLockData } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function setWorkflowLockAction(
  workspaceId: string,
  path: SetWorkflowLockData["path"],
  body: SetWorkflowLockData["body"]
) {
  const result = await setWorkflowLock({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path,
    body,
  })
  if (result.error) return { error: result.error }

  updateTag(`${agentWorkflowsTag(path.agentName)}:${workspaceId}`)
  updateTag(workflowTag(path.agentName, path.workflowName))
  return { lock: result.data }
}
