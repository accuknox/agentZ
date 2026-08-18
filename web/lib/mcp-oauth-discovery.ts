import "server-only"

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client"
import { headers } from "next/headers"
import * as z from "zod"
import { getAuth } from "@/lib/auth"
import {
  discoveredOAuth,
  parseStoredOAuthDiscoveryState,
  publicOAuthFetch,
  requirePublicOAuthDiscoveryState,
  requirePublicOAuthURL,
  type StoredOAuthDiscoveryState,
} from "@/lib/mcp-oauth"

type OAuthDiscoveryOptions = {
  endpointLabel: string
  manualMessage: string
}

const discoveryRequestSchema = z.object({ endpointUrl: z.url() })

export async function handleOAuthDiscovery(request: Request, options: OAuthDiscoveryOptions) {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ message: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ message: "Request body must be valid JSON" }, { status: 400 })
  }

  const parsed = discoveryRequestSchema.safeParse(body)
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? `${options.endpointLabel} must be a valid URL`
    return Response.json({ message }, { status: 400 })
  }

  let serverURL: URL
  try {
    serverURL = await requirePublicOAuthURL(parsed.data.endpointUrl, options.endpointLabel)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `${options.endpointLabel} is not allowed`
    return Response.json({ message }, { status: 400 })
  }

  let resourceMetadata: StoredOAuthDiscoveryState["resourceMetadata"]
  let authorizationServerURL = new URL("/", serverURL).toString()
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverURL,
      undefined,
      publicOAuthFetch
    )
    const discoveredURL = resourceMetadata.authorization_servers?.[0]
    const parsedURL = z.url().safeParse(discoveredURL)
    if (parsedURL.success) {
      const publicURL = await requirePublicOAuthURL(parsedURL.data, "OAuth issuer URL")
      authorizationServerURL = publicURL.toString()
    }
  } catch {
    // Authorization server discovery from the endpoint origin is the defined fallback.
  }

  let authorizationServerMetadata: StoredOAuthDiscoveryState["authorizationServerMetadata"]
  try {
    authorizationServerMetadata = await discoverAuthorizationServerMetadata(
      authorizationServerURL,
      { fetchFn: publicOAuthFetch }
    )
  } catch {
    return Response.json({ message: options.manualMessage }, { status: 502 })
  }

  let discoveryState: StoredOAuthDiscoveryState
  try {
    discoveryState = parseStoredOAuthDiscoveryState({
      authorizationServerMetadata,
      authorizationServerUrl: authorizationServerURL,
      resourceMetadata,
    })
    await requirePublicOAuthDiscoveryState(discoveryState)
  } catch {
    return Response.json({ message: options.manualMessage }, { status: 502 })
  }

  const discovered = discoveredOAuth(discoveryState)
  return Response.json({
    default_scopes: discovered.defaultScopes,
    oauth: discovered.oauth,
    supported_scopes: discovered.supportedScopes,
  })
}
