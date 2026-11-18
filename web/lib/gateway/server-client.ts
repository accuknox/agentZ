import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { createClient, createConfig, type Client } from "@/lib/gateway/client/client"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { gatewayErrorInterceptor, GatewayUnauthorizedError } from "@/lib/gateway/errors"
import { serverGatewayBaseURL } from "@/lib/gateway/server-base-url"
import { signInURL } from "@/lib/sign-in-redirect"

const clients = new Map<string, Client>()

/**
 * getGatewayServerClient lazily configures the generated SDK after runtime
 * configuration is available, while reusing its interceptor registry.
 */
export function getGatewayServerClient(workspaceId?: string): Client {
  const scope = workspaceId ?? ""
  const existing = clients.get(scope)
  if (existing) {
    return existing
  }

  const client = createClient(
    createConfig({
      auth: () => currentGatewayAuthToken(workspaceId),
      baseUrl: serverGatewayBaseURL(),
    })
  )
  client.interceptors.error.use(async (error, response) => {
    if (error instanceof GatewayUnauthorizedError) {
      redirect(signInURL({ error: "session_expired" }))
    }

    const gatewayError = gatewayErrorInterceptor(error, response)
    if (gatewayError.code === "tenant_not_ready") {
      const pathname = (await headers()).get("x-agentz-pathname")
      const [, root, orgSlug] = pathname?.split("/") ?? []
      if (root === "orgs" && orgSlug) {
        redirect(`/orgs/${orgSlug}/setting-up`)
      }
    }

    return gatewayError
  })

  clients.set(scope, client)
  return client
}
