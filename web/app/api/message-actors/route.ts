import { NextResponse } from "next/server"
import { z } from "zod"
import { getMessageActorProfiles } from "@/data/members"
import { GatewayUnauthorizedError } from "@/lib/gateway/errors"

const requestSchema = z.object({ userIds: z.array(z.string().min(1)).max(25) }).strict()

/** POST returns current profiles for attributed users in the active organization. */
export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) {
    return NextResponse.json({ message: "Invalid request body" }, { status: 400 })
  }

  try {
    const profiles = await getMessageActorProfiles([...new Set(parsed.data.userIds)])
    return NextResponse.json({ profiles }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    if (error instanceof GatewayUnauthorizedError) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }
    throw error
  }
}
