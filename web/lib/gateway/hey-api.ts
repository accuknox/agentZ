import type { CreateClientConfig } from "@/lib/gateway/client/client"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { clientRedirectToLogin } from "@/lib/login-redirect"

async function gatewayToken(): Promise<string> {
  const response = await fetch("/api/gateway/token", {
    cache: "no-store",
    credentials: "same-origin",
  })

  if (response.status === 401) {
    clientRedirectToLogin()
    throw new Error("Unauthorized")
  }

  if (!response.ok) {
    throw new Error("Failed to load gateway token")
  }

  const body = (await response.json()) as { token?: string }
  if (!body.token) {
    throw new Error("Failed to load gateway token")
  }

  return body.token
}

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  auth: () => gatewayToken(),
  baseUrl: gatewayBaseURL(),
})
