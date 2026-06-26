import "server-only"

import { redirect } from "next/navigation"
import { createClient, createConfig, type Client } from "@/lib/gateway/client/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { loginURL } from "@/lib/login-redirect"

/**
 * buildGatewayServerClient routes server-side SDK calls through the internal
 * gateway origin when it is configured.
 */
function buildGatewayServerClient(): Client {
  const client = createClient(
    createConfig({
      auth: () => currentGatewayAuthToken(),
      baseUrl: serverGatewayBaseURL(),
    })
  )

  // Convert GatewayUnauthorizedError back to redirect(). The interceptor runs
  // inside the SDK's catch block, so the throw escapes cleanly, unlike
  // redirect() called from the auth() callback inside the try.
  client.interceptors.error.use((error) => {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(loginURL({ error: "session_expired" }))
    }
    return error
  })

  return client
}

let client: Client | undefined

function getGatewayServerClient(): Client {
  client ??= buildGatewayServerClient()
  return client
}

/**
 * gatewayServerClient lazily resolves the SDK client so route collection does
 * not require runtime-only server URL configuration at build time.
 */
export const gatewayServerClient: Client = new Proxy({} as Client, {
  get(_, property, receiver) {
    const value = Reflect.get(getGatewayServerClient(), property, receiver)
    if (typeof value === "function") {
      return value.bind(getGatewayServerClient())
    }
    return value
  },
})
