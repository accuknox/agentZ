"use client"

import * as z from "zod"
import { clientRedirectToSignIn } from "@/lib/sign-in-redirect"
import type { ClientOptions } from "@/lib/gateway/client"

const gatewayBaseURLSchema = z
  .string()
  .url()
  .transform((value) => {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Gateway base URL must use http or https")
    }

    return url.origin as ClientOptions["baseUrl"]
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

function withBearerToken(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set("Authorization", `Bearer ${token}`)

  return new Request(request, {
    headers,
    signal: request.signal,
  })
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
export async function getGatewayToken(): Promise<string> {
  const body = await fetchGatewayResponse(
    "/api/gateway/token",
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
  const [request, token] = await Promise.all([
    Promise.resolve(new Request(input, init)),
    getGatewayToken(),
  ])

  return fetch(withBearerToken(request, token))
}
