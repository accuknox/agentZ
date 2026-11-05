"use client"

import * as z from "zod"
import { decodeJwt } from "jose"
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
type GatewayToken = { token: Promise<string>; refreshAt: number }
const gatewayTokens = new Map<string, GatewayToken>()

/** clearGatewayTokens drops credentials when the login or organization changes. */
export function clearGatewayTokens(): void {
  gatewayTokens.clear()
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

  return schema.parseAsync(await response.json())
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
 * getGatewayToken shares a scoped credential until shortly before expiry.
 * Pending mints are shared too, so concurrent reads do not stampede auth.
 */
export async function getGatewayToken(workspaceId?: string): Promise<string> {
  const scope = workspaceId ?? ""
  const current = gatewayTokens.get(scope)
  if (current && current.refreshAt > Date.now()) return current.token
  const path = workspaceId
    ? `/api/gateway/token?workspace_id=${encodeURIComponent(workspaceId)}`
    : "/api/gateway/token"
  const entry: GatewayToken = {
    refreshAt: Infinity,
    token: fetchGatewayResponse(
      path,
      "Failed to load gateway token",
      gatewayTokenResponseSchema
    ).then((body) => {
      // The gateway verifies the signature. Decoding here only schedules refresh.
      const exp = z.number().finite().parse(decodeJwt(body.token).exp)
      entry.refreshAt = (exp - 15) * 1_000
      return body.token
    }),
  }
  gatewayTokens.set(scope, entry)
  try {
    return await entry.token
  } catch (error) {
    if (gatewayTokens.get(scope) === entry) gatewayTokens.delete(scope)
    throw error
  }
}

/**
 * gatewayAuthenticatedFetch supplies a valid scoped JWT on every request,
 * including SDK-managed SSE retries. A rejected bearer is refreshed once.
 */
export async function gatewayAuthenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  signal?.throwIfAborted()
  const requestHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  const workspaceId = new Headers(requestHeaders).get("X-AgentZ-Workspace-ID") ?? undefined
  const [token, baseUrl] = await Promise.all([getGatewayToken(workspaceId), getGatewayBaseURL()])
  signal?.throwIfAborted()

  let target = input
  if (!(input instanceof Request)) {
    const url = new URL(input, baseUrl)
    const gateway = new URL(baseUrl)
    url.protocol = gateway.protocol
    url.host = gateway.host
    target = url
  }
  const request = new Request(target, init)
  request.headers.set("Authorization", `Bearer ${token}`)
  // Clone before dispatch so authentication failures can retry JSON, uploads
  // and other request bodies without consuming the caller's stream twice.
  const retry = request.clone()
  const response = await fetch(request)
  if (response.status !== 401) return response
  await response.body?.cancel()
  signal?.throwIfAborted()
  const scope = workspaceId ?? ""
  const current = gatewayTokens.get(scope)
  const cached = await current?.token
  if (gatewayTokens.get(scope) === current && cached === token) gatewayTokens.delete(scope)
  retry.headers.set("Authorization", `Bearer ${await getGatewayToken(workspaceId)}`)
  signal?.throwIfAborted()
  return fetch(retry)
}
