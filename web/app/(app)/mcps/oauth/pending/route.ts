import { cookies } from "next/headers"
import { mcpOAuthCookieName, oauthCookieOptions } from "@/lib/mcp-oauth"

export async function POST() {
  const cookieStore = await cookies()
  cookieStore.set(mcpOAuthCookieName, "", {
    ...oauthCookieOptions(),
    maxAge: 0,
  })
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
    },
  })
}
