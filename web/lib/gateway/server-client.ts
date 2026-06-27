import "server-only"

import { redirect } from "next/navigation"
import { createClient, createConfig, type Client } from "@/lib/gateway/client/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { loginURL } from "@/lib/login-redirect"

let client: Client | undefined

/**
 * getGatewayServerClient lazily configures the generated SDK after runtime
 * configuration is available, while reusing its interceptor registry.
 */
export function getGatewayServerClient(): Client {
  if (client) {
    return client
  }

  client = createClient(
    createConfig({
      auth: () => currentGatewayAuthToken(),
      baseUrl: serverGatewayBaseURL(),
    })
  )
  client.interceptors.error.use((error) => {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(loginURL({ error: "session_expired" }))
    }
    return error
  })

  return client
}
