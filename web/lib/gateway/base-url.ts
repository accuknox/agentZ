import "server-only"

/**
 * gatewayBaseURL returns the public gateway origin from server runtime
 * configuration.
 */
export function gatewayBaseURL(): string {
  const rawGatewayBaseURL = process.env.GATEWAY_BASE_URL?.trim()
  if (!rawGatewayBaseURL) {
    throw new Error("GATEWAY_BASE_URL is not configured")
  }

  const gatewayBaseURL = new URL(rawGatewayBaseURL)
  if (gatewayBaseURL.protocol !== "http:" && gatewayBaseURL.protocol !== "https:") {
    throw new Error("GATEWAY_BASE_URL must use http or https")
  }

  return gatewayBaseURL.origin
}
