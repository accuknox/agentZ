import { connection } from "next/server"
import { NextResponse } from "next/server"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

/**
 * GET returns a freshly minted gateway bearer token for one browser API call.
 */
export async function GET(): Promise<Response> {
  await connection()

  try {
    return NextResponse.json(
      {
        token: await currentGatewayAuthToken(),
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
