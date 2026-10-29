import "server-only"

import { serverWebBaseURL } from "@/lib/gateway/server-base-url"
import { mcpOAuthCallbackPath } from "@/lib/mcp-oauth-shared"

export function mcpOAuthCallbackURL(): string {
  return new URL(mcpOAuthCallbackPath, serverWebBaseURL()).href
}
