import type { Route } from "next"

/**
 * signInReturnTo keeps post-auth redirects on internal app paths only.
 */
export function signInReturnTo(value?: string): Route | undefined {
  if (!value) {
    return
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return
  }

  return value as Route
}

/**
 * signInURL builds the sign-in URL with an optional auth error and return path.
 */
export function signInURL({
  error,
  provider,
  returnTo,
}: {
  error?: string
  provider?: string
  returnTo?: string
} = {}): Route {
  const params = new URLSearchParams()
  if (error) {
    params.set("error", error)
  }
  if (provider) {
    params.set("provider", provider)
  }

  const path = signInReturnTo(returnTo)
  if (path) {
    params.set("returnTo", path)
  }

  const search = params.toString()
  if (!search) {
    return "/signin"
  }

  return `/signin?${search}` as Route
}

/**
 * clientRedirectToSignIn navigates to /signin with session_expired and the
 * current path as returnTo. Used by client-side error interceptors that detect
 * a revoked session after it crosses the Server Action boundary.
 */
export function clientRedirectToSignIn(): void {
  window.location.replace(
    signInURL({
      error: "session_expired",
      returnTo: `${window.location.pathname}${window.location.search}`,
    })
  )
}
