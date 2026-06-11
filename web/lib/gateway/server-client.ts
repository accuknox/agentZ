import "server-only"

import { createClient, createConfig, type Client } from "@/lib/gateway/client/client"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"

/**
 * gatewayServerClient routes server-side SDK calls through the internal
 * gateway origin when it is configured.
 */
export const gatewayServerClient: Client = createClient(
  createConfig({
    baseUrl: serverGatewayBaseURL(),
  })
)
