import "server-only"

import { redirect } from "next/navigation"
import { createClient, createConfig, type Client } from "@/lib/gateway/client/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { loginURL } from "@/lib/login-redirect"

/**
 * gatewayServerClient routes server-side SDK calls through the internal
 * gateway origin when it is configured.
 */
export const gatewayServerClient: Client = createClient(
  createConfig({
    auth: () => currentGatewayAuthToken(),
    baseUrl: serverGatewayBaseURL(),
  })
)

// Convert GatewayUnauthorizedError back to redirect(). The interceptor runs
// inside the SDK's catch block, so the throw escapes cleanly, unlike redirect()
// called from the auth() callback inside the try.
gatewayServerClient.interceptors.error.use((error) => {
  if (error instanceof GatewayUnauthorizedError) {
    redirect(loginURL({ error: "session_expired" }))
  }
  return error
})
