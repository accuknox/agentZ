import "server-only"

function configuredURL(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (!value) {
    return
  }

  return value.endsWith("/") ? value.slice(0, -1) : value
}

/**
 * serverGatewayBaseURL returns the server-side gateway origin.
 */
export function serverGatewayBaseURL(): string {
  const gatewayInternalBaseURL = configuredURL("GATEWAY_INTERNAL_BASE_URL")
  if (gatewayInternalBaseURL) {
    return gatewayInternalBaseURL
  }

  const gatewayBaseURL = configuredURL("GATEWAY_BASE_URL")
  if (gatewayBaseURL) {
    return gatewayBaseURL
  }

  throw new Error("GATEWAY_BASE_URL is not configured")
}

/**
 * serverWebBaseURL returns the public web origin used for server-side callback
 * URLs (e.g. MCP OAuth redirects). BETTER_AUTH_URL is the web app's own public
 * URL; in prod the gateway and web app share the same origin, in dev they're
 * on different ports.
 */
export function serverWebBaseURL(): string {
  const webURL = configuredURL("BETTER_AUTH_URL")
  if (webURL) {
    return webURL
  }

  throw new Error("BETTER_AUTH_URL is not configured")
}
