/**
 * trimTrailingSlash keeps configured origins stable for URL composition.
 */
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

/**
 * gatewayBaseURL returns the public gateway origin used by browser code.
 */
export function gatewayBaseURL(): string {
  const gatewayOrigin = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL?.trim()
  if (!gatewayOrigin) {
    throw new Error("NEXT_PUBLIC_GATEWAY_BASE_URL is not configured")
  }

  return trimTrailingSlash(gatewayOrigin)
}

/**
 * webBaseURL returns the configured public web origin.
 *
 * OAuth callback routes are served by the web app. When a dedicated web
 * origin is not configured, fall back to the gateway origin so deployments
 * that use a single public host do not fail at runtime.
 */
export function webBaseURL(): string {
  const webOrigin = process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim()
  if (webOrigin) {
    return trimTrailingSlash(webOrigin)
  }

  return gatewayBaseURL()
}
