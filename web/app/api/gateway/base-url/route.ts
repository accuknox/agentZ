import { connection } from "next/server"
import { NextResponse } from "next/server"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

/**
 * GET returns the public gateway origin for direct browser API calls.
 */
export async function GET(): Promise<Response> {
  await connection()

  try {
    await currentGatewayAuthContext()

    return NextResponse.json(
      {
        baseUrl: gatewayBaseURL(),
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
