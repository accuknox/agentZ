import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client"
import { headers } from "next/headers"
import { NextResponse } from "next/server"
import * as z from "zod"
import { auth } from "@/lib/auth"
import {
  discoveredOAuth,
  parseStoredOAuthDiscoveryState,
  type StoredOAuthDiscoveryState,
} from "@/lib/mcp-oauth"

const manualDiscoveryMessage =
  "Auto-discovery failed. If the MCP server supports OAuth, please fill in the required fields in advanced section manually."

const httpsURLSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value)
  if (url.protocol !== "https:") {
    ctx.addIssue({
      code: "custom",
      message: "MCP server URL must use HTTPS",
    })
  }
  if (url.username || url.password) {
    ctx.addIssue({
      code: "custom",
      message: "MCP server URL must not include credentials",
    })
  }
})

const discoveryRequestSchema = z.object({
  endpointUrl: httpsURLSchema,
})

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  })
  if (!session) {
    return NextResponse.json(
      {
        message: "Unauthorized",
      },
      { status: 401 }
    )
  }

  const raw = await request.text()
  if (!raw.trim()) {
    return NextResponse.json(
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
    return NextResponse.json(
      {
        message: "Request body must be valid JSON",
      },
      { status: 400 }
    )
  }

  const parsed = discoveryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        message: parsed.error.issues[0]?.message ?? "MCP server URL must be a valid URL",
      },
      { status: 400 }
    )
  }

  const serverUrl = new URL(parsed.data.endpointUrl)
  const fallbackAuthorizationServerUrl = new URL("/", serverUrl).toString()

  let resourceMetadata: StoredOAuthDiscoveryState["resourceMetadata"]
  let authorizationServerUrl = fallbackAuthorizationServerUrl

  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl)
    const discoveredAuthorizationServerUrl = resourceMetadata.authorization_servers?.[0]
    const parsedAuthorizationServerUrl = httpsURLSchema.safeParse(discoveredAuthorizationServerUrl)
    authorizationServerUrl = parsedAuthorizationServerUrl.success
      ? parsedAuthorizationServerUrl.data
      : fallbackAuthorizationServerUrl
  } catch {
    // Ignore protected resource discovery failures and fall back to
    // authorization server discovery from the endpoint origin.
  }

  let authorizationServerMetadata: StoredOAuthDiscoveryState["authorizationServerMetadata"]

  try {
    authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl)
  } catch {
    return NextResponse.json(
      {
        message: manualDiscoveryMessage,
      },
      { status: 502 }
    )
  }

  let discoveryState: StoredOAuthDiscoveryState
  try {
    discoveryState = parseStoredOAuthDiscoveryState({
      authorizationServerUrl,
      resourceMetadata,
      authorizationServerMetadata,
    })
  } catch {
    return NextResponse.json(
      {
        message: manualDiscoveryMessage,
      },
      { status: 502 }
    )
  }

  const discovered = discoveredOAuth(discoveryState)

  return NextResponse.json({
    oauth: discovered.oauth,
    default_scopes: discovered.defaultScopes,
    supported_scopes: discovered.supportedScopes,
  })
}
