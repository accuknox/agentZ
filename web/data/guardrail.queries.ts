import "server-only"

import { cacheLife } from "next/cache"
import {
  listGuardrailConnections,
  listGuardrailPolicies,
  getGuardrailSettings,
  listGuardrailEventSources,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listGuardrailEventSourcesQuery(workspaceId?: string) {
  "use cache: private"

  cacheLife("minutes")
  const result = await listGuardrailEventSources({
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
  if (result.error) return { error: result.error }
  return { data: result.data }
}

export function listGuardrailConnectionsQuery(workspaceId?: string) {
  return listGuardrailConnections({
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
}

export function listGuardrailPoliciesQuery(workspaceId?: string) {
  return listGuardrailPolicies({
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
}

export function getGuardrailSettingsQuery(workspaceId?: string) {
  return getGuardrailSettings({
    client: getGatewayServerClient(workspaceId),
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  })
}
