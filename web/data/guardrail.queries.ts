import "server-only"

import {
  listGuardrailConnections,
  listGuardrailPolicies,
  getGuardrailSettings,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

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
