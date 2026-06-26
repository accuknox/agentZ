import { connection } from "next/server"
import { NextResponse } from "next/server"
import { currentGatewayAuthToken } from "@/lib/gateway/auth"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

export async function GET() {
  await connection()

  try {
    return NextResponse.json({
      token: await currentGatewayAuthToken(),
    })
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    throw error
  }
}
