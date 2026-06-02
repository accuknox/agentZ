import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client"
import { NextResponse } from "next/server"
import * as z from "zod"
import { discoveredOAuthAuth, type StoredOAuthDiscoveryState } from "@/lib/mcp-oauth"

const manualDiscoveryMessage =
  "Auto-discovery failed. If the MCP server supports OAuth, please fill in the required fields in advanced section manually."

const discoveryRequestSchema = z.object({
  endpointUrl: z.url(),
})

export async function POST(request: Request) {
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
        message: "MCP server URL must be a valid URL",
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
    authorizationServerUrl =
      resourceMetadata.authorization_servers?.[0] ?? fallbackAuthorizationServerUrl
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

  const discoveryState = {
    authorizationServerUrl,
    resourceMetadata,
    authorizationServerMetadata,
  } satisfies StoredOAuthDiscoveryState
  const oauth = discoveredOAuthAuth(discoveryState)

  return NextResponse.json({
    oauth,
  })
}
