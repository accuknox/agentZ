import "server-only"

import { getTenant } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function tenantNamespaceForSkills(): Promise<string> {
  const result = await getTenant({
    client: getGatewayServerClient(),
  })
  if (result.error) {
    throw new Error(result.error.message)
  }
  return result.data.namespace
}
