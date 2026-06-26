import "server-only"
import { gatewayBaseURL } from "@/lib/gateway/base-url"

/**
 * serverGatewayBaseURL returns the server-side gateway origin.
 */
export function serverGatewayBaseURL(): string {
  const rawInternalGatewayBaseURL = process.env.INTERNAL_GATEWAY_BASE_URL?.trim()
  if (rawInternalGatewayBaseURL) {
    const internalGatewayBaseURL = new URL(rawInternalGatewayBaseURL)
    if (
      internalGatewayBaseURL.protocol !== "http:" &&
      internalGatewayBaseURL.protocol !== "https:"
    ) {
      throw new Error("INTERNAL_GATEWAY_BASE_URL must use http or https")
    }

    return internalGatewayBaseURL.origin
  }

  const rawGatewayBaseURL = process.env.GATEWAY_BASE_URL?.trim()
  if (rawGatewayBaseURL) {
    const serverGatewayBaseURL = new URL(rawGatewayBaseURL)
    if (serverGatewayBaseURL.protocol !== "http:" && serverGatewayBaseURL.protocol !== "https:") {
      throw new Error("GATEWAY_BASE_URL must use http or https")
    }

    return serverGatewayBaseURL.origin
  }

  return gatewayBaseURL()
}

/**
 * serverWebBaseURL returns the public web origin used for server-side callback
 * URLs (e.g. MCP OAuth redirects). BETTER_AUTH_URL is the web app's own public
 * URL; in prod the gateway and web app share the same origin, in dev they're
 * on different ports.
 */
export function serverWebBaseURL(): string {
  const rawWebURL = process.env.BETTER_AUTH_URL?.trim()
  if (rawWebURL) {
    const webURL = new URL(rawWebURL)
    if (webURL.protocol !== "http:" && webURL.protocol !== "https:") {
      throw new Error("BETTER_AUTH_URL must use http or https")
    }

    return webURL.origin
  }

  return gatewayBaseURL()
}
