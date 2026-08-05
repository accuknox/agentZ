import { NextResponse } from "next/server"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

/**
 * GET returns a freshly minted gateway bearer token for one browser API call.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id")
    if (workspaceId !== null && (workspaceId.length === 0 || workspaceId.length > 128)) {
      return NextResponse.json({ message: "Invalid Workspace" }, { status: 400 })
    }
    return NextResponse.json(
      {
        token: await currentGatewayAuthToken(workspaceId ?? undefined),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    )
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    throw error
  }
}
