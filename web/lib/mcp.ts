import type { McpConnection } from "@/lib/gateway/client"

export function authModeOf(connection: McpConnection) {
  if (connection.auth?.oauth) {
    return "oauth" as const
  }
  if (connection.auth?.bearer) {
    return "bearer" as const
  }
  return "none" as const
}
