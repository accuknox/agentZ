"use client"

import * as z from "zod"
import { clientRedirectToSignIn } from "@/lib/sign-in-redirect"
import type { ClientOptions } from "@/lib/gateway/client"

const gatewayBaseURLSchema = z.url().transform((value) => {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway base URL must use http or https")
  }

  return url.origin
})

const gatewayBaseURLResponseSchema = z.object({
  baseUrl: gatewayBaseURLSchema,
})

const gatewayTokenResponseSchema = z.object({
  token: z.string().min(1),
})

const gatewayFetchInit = {
  cache: "no-store",
  credentials: "same-origin",
} as const

let gatewayBaseURLPromise: Promise<ClientOptions["baseUrl"]> | undefined

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await response.json()
  return await schema.parseAsync(body)
}

async function fetchGatewayResponse<T>(
  path: string,
  errorMessage: string,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await fetch(path, gatewayFetchInit)

  if (response.status === 401) {
    clientRedirectToSignIn()
    throw new Error("Unauthorized")
  }
  if (!response.ok) {
    throw new Error(errorMessage)
  }

  return await parseResponse(response, schema)
}

/**
 * getGatewayBaseURL returns the browser-safe gateway origin for direct API
 * calls.
 */
export async function getGatewayBaseURL(): Promise<ClientOptions["baseUrl"]> {
  if (!gatewayBaseURLPromise) {
    gatewayBaseURLPromise = fetchGatewayResponse(
      "/api/gateway/base-url",
      "Failed to load gateway base URL",
      gatewayBaseURLResponseSchema
    )
      .then((body) => body.baseUrl)
      .catch((error) => {
        gatewayBaseURLPromise = undefined
        throw error
      })
  }

  return await gatewayBaseURLPromise
}

/**
 * getGatewayToken returns a freshly minted gateway bearer token for one
 * browser API call.
 */
async function getGatewayToken(workspaceId?: string): Promise<string> {
  const path = workspaceId
    ? `/api/gateway/token?workspace_id=${encodeURIComponent(workspaceId)}`
    : "/api/gateway/token"
  const body = await fetchGatewayResponse(
    path,
    "Failed to load gateway token",
    gatewayTokenResponseSchema
  )
  return body.token
}

/**
 * gatewayAuthenticatedFetch refreshes the short-lived gateway JWT for every
 * browser request so SSE reconnects never reuse an expired bearer token.
 */
export async function gatewayAuthenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const requestHeaders = input instanceof Request ? input.headers : init?.headers
  const workspaceId = new Headers(requestHeaders).get("X-AgentZ-Workspace-ID") ?? undefined
  const [token, baseUrl] = await Promise.all([getGatewayToken(workspaceId), getGatewayBaseURL()])

  if (input instanceof Request) {
    const headers = new Headers(input.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return fetch(new Request(input, { headers }))
  }

  const url = new URL(input, baseUrl)
  const gateway = new URL(baseUrl)
  url.protocol = gateway.protocol
  url.host = gateway.host
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)

  return fetch(url, { ...init, headers })
}
