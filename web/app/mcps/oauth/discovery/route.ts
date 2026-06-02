import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client"
import { NextResponse } from "next/server"
import * as z from "zod"
import { discoveredOAuthAuth, type StoredOAuthDiscoveryState } from "@/lib/mcp-oauth"

const manualDiscoveryMessage =
  "Auto-discovery failed, please fill in the required fields in advanced section manually."

const discoveryRequestSchema = z.object({
  endpointUrl: z.string().url(),
})

export async function POST(request: Request) {
  const body = await request.json()
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
  let resourceError: string | undefined

  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl)
    authorizationServerUrl =
      resourceMetadata.authorization_servers?.[0] ?? fallbackAuthorizationServerUrl
  } catch (error) {
    resourceError =
      error instanceof Error
        ? error.message
        : "Protected resource metadata could not be discovered."
  }

  let authorizationServerMetadata: StoredOAuthDiscoveryState["authorizationServerMetadata"]
  let authorizationError: string | undefined

  try {
    authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl)
  } catch (error) {
    authorizationError =
      error instanceof Error
        ? error.message
        : "Authorization server metadata could not be discovered."
  }

  if (!resourceMetadata && !authorizationServerMetadata) {
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
