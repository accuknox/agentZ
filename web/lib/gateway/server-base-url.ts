import "server-only"

import { gatewayBaseURL } from "@/lib/gateway/base-url"

/**
 * serverGatewayBaseURL returns the internal gateway origin for server-side
 * requests and falls back to the public gateway origin when unset.
 */
export function serverGatewayBaseURL(): string {
  const gatewayOrigin = process.env.GATEWAY_INTERNAL_BASE_URL?.trim()
  if (!gatewayOrigin) {
    return gatewayBaseURL()
  }

  return gatewayOrigin.endsWith("/") ? gatewayOrigin.slice(0, -1) : gatewayOrigin
}
