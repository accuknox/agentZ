/**
 * loginReturnTo keeps post-login redirects on internal app paths only.
 */
export function loginReturnTo(value?: string): string | undefined {
  if (!value) {
    return
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return
  }

  return value
}

/**
 * loginURL builds the login URL with an optional auth error and return path.
 */
export function loginURL({
  error,
  returnTo,
}: {
  error?: string
  returnTo?: string
} = {}): string {
  const params = new URLSearchParams()
  if (error) {
    params.set("error", error)
  }

  const path = loginReturnTo(returnTo)
  if (path) {
    params.set("returnTo", path)
  }

  const search = params.toString()
  if (!search) {
    return "/login"
  }

  return `/login?${search}`
}

/**
 * clientRedirectToLogin navigates to /login with session_expired and the
 * current path as returnTo. Used by client-side error interceptors that
 * detect a revoked session after it crosses the Server Action boundary.
 */
export function clientRedirectToLogin(): void {
  window.location.replace(
    loginURL({
      error: "session_expired",
      returnTo: `${window.location.pathname}${window.location.search}`,
    })
  )
}
