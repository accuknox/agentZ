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

const manualDiscoveryMessage =
  "Auto-discovery failed. If this OAuth server supports discovery, fill in the required fields in advanced manually."

const httpsURLSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value)
  if (url.protocol !== "https:") {
    ctx.addIssue({
      code: "custom",
      message: "OAuth server URL must use HTTPS",
    })
  }
  if (url.username || url.password) {
    ctx.addIssue({
      code: "custom",
      message: "OAuth server URL must not include credentials",
    })
  }
})

const discoveryRequestSchema = z.object({
  endpointUrl: httpsURLSchema,
})

export async function POST(request: Request) {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    return Response.json(
      {
        message: "Unauthorized",
      },
      { status: 401 }
    )
  }

  const raw = await request.text()
  if (!raw.trim()) {
    return Response.json(
      {
        message: "Request body must be valid JSON",
      },
      { status: 400 }
    )
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json(
      {
        message: "Request body must be valid JSON",
      },
      { status: 400 }
    )
  }

  const parsed = discoveryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      {
        message: parsed.error.issues[0]?.message ?? "OAuth server URL must be a valid URL",
      },
      { status: 400 }
    )
  }

  let serverURL: URL
  try {
    serverURL = await requirePublicOAuthURL(parsed.data.endpointUrl, "OAuth server URL")
  } catch (error) {
    return Response.json(
      {
        message: error instanceof Error ? error.message : "OAuth server URL is not allowed",
      },
      { status: 400 }
    )
  }
  const fallbackAuthorizationServerURL = new URL("/", serverURL).toString()

  let resourceMetadata: StoredOAuthDiscoveryState["resourceMetadata"]
  let authorizationServerURL = fallbackAuthorizationServerURL

  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverURL,
      undefined,
      publicOAuthFetch
    )
    const discoveredAuthorizationServerURL = resourceMetadata.authorization_servers?.[0]
    const parsedAuthorizationServerURL = httpsURLSchema.safeParse(discoveredAuthorizationServerURL)
    if (parsedAuthorizationServerURL.success) {
      const publicAuthorizationServerURL = await requirePublicOAuthURL(
        parsedAuthorizationServerURL.data,
        "OAuth issuer URL"
      )
      authorizationServerURL = publicAuthorizationServerURL.toString()
    }
  } catch {
    // Ignore protected resource discovery failures and fall back to
    // authorization server discovery from the endpoint origin.
  }

  let authorizationServerMetadata: StoredOAuthDiscoveryState["authorizationServerMetadata"]
  try {
    authorizationServerMetadata = await discoverAuthorizationServerMetadata(
      authorizationServerURL,
      {
        fetchFn: publicOAuthFetch,
      }
    )
  } catch {
    return Response.json(
      {
        message: manualDiscoveryMessage,
      },
      { status: 502 }
    )
  }

  let discoveryState: StoredOAuthDiscoveryState
  try {
    discoveryState = parseStoredOAuthDiscoveryState({
      authorizationServerUrl: authorizationServerURL,
      resourceMetadata,
      authorizationServerMetadata,
    })
    await requirePublicOAuthDiscoveryState(discoveryState)
  } catch {
    return Response.json(
      {
        message: manualDiscoveryMessage,
      },
      { status: 502 }
    )
  }

  const discovered = discoveredOAuth(discoveryState)
  return Response.json({
    oauth: discovered.oauth,
    default_scopes: discovered.defaultScopes,
    supported_scopes: discovered.supportedScopes,
  })
}
