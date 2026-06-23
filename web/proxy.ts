import { NextResponse, type NextRequest } from "next/server"
import { getSessionCookie } from "better-auth/cookies"
import { loginURL } from "@/lib/login-redirect"

/**
 * proxy is the Next.js 16 request gate. Checks for a session cookie on
 * every matched navigation; redirects to /login if absent. This catches
 * the no-cookie case (logged out, expired) at the boundary.
 *
 * Revoked sessions (cookie present but DB session deleted) are caught by
 * the GatewayUnauthorizedError flow in the error interceptors.
 *
 * Server Function POSTs are excluded via the `missing` matcher - a 307
 * redirect response to a POST is handled awkwardly by the fetch layer,
 * so the error interceptor approach is cleaner there.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) {
    return NextResponse.next()
  }

  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`
  return NextResponse.redirect(new URL(loginURL({ returnTo }), request.url))
}

export const config = {
  matcher: [
    {
      source: "/((?!login|api/auth|_next/static|_next/image|.*\\..*).*)",
      missing: [{ type: "header", key: "next-action" }],
    },
  ],
}
