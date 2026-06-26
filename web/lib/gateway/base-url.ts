/**
 * gatewayBaseURL returns the current public gateway origin.
 */
export function gatewayBaseURL(): string {
  if (typeof window !== "undefined") {
    return window.location.origin
  }

  const gatewayBaseURL = process.env.GATEWAY_BASE_URL?.trim()
  if (gatewayBaseURL) {
    return gatewayBaseURL.endsWith("/") ? gatewayBaseURL.slice(0, -1) : gatewayBaseURL
  }

  // Next.js may evaluate browser-only client modules on the server while
  // collecting route metadata during build. Runtime startup still validates
  // GATEWAY_BASE_URL in bootstrap.cjs before the standalone server accepts
  // traffic.
  return "http://127.0.0.1"
}
