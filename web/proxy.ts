import { NextResponse, type NextRequest } from "next/server"
import { getSessionCookie } from "better-auth/cookies"
import { signInURL } from "@/lib/sign-in-redirect"

/**
 * proxy is the Next.js 16 request gate. Checks for a session cookie on
 * every matched navigation; redirects to /signin if absent. This catches
 * the no-cookie case (logged out, expired) at the boundary.
 *
 * Revoked sessions (cookie present but DB session deleted) are caught by
 * the GatewayUnauthorizedError flow in the error interceptors.
 *
 * Server Function POSTs bypass the cookie redirect because a 307 response
 * is handled awkwardly by the fetch layer. Their actions enforce access at
 * the data boundary, while malformed action requests are rejected here.
 */
export function proxy(request: NextRequest) {
  const actionId = request.headers.get("next-action")
  if (actionId !== null) {
    if (request.method !== "POST" || actionId.length !== 42) {
      return new NextResponse("Invalid Server Action request", { status: 400 })
    }
    return NextResponse.next()
  }

  if (getSessionCookie(request)) {
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set("x-agentz-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`)
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`
  return NextResponse.redirect(new URL(signInURL({ returnTo }), request.url))
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|.*\\..*).*)",
      has: [{ type: "header", key: "next-action" }],
    },
    "/((?!join|signin|signup|api/auth|_next/static|_next/image|.*\\..*).*)",
  ],
}
