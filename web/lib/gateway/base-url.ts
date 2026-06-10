const gatewayOrigin = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL?.trim()
const webOrigin = process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim()

/**
 * gatewayBaseURL returns the configured gateway origin.
 */
export function gatewayBaseURL(): string {
  if (!gatewayOrigin) {
    throw new Error("NEXT_PUBLIC_GATEWAY_BASE_URL is not configured")
  }

  return gatewayOrigin.endsWith("/") ? gatewayOrigin.slice(0, -1) : gatewayOrigin
}

/**
 * webBaseURL returns the configured public web origin.
 *
 * OAuth callback routes are served by the web app. When a dedicated web
 * origin is not configured, fall back to the gateway origin so deployments
 * that use a single public host do not fail at runtime.
 */
export function webBaseURL(): string {
  if (webOrigin) {
    return webOrigin.endsWith("/") ? webOrigin.slice(0, -1) : webOrigin
  }

  return gatewayBaseURL()
}
