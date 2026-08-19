import { handleOAuthDiscovery } from "@/lib/mcp-oauth-discovery"

export function POST(request: Request) {
  return handleOAuthDiscovery(request, {
    endpointLabel: "MCP server URL",
    manualMessage:
      "Auto-discovery failed. If the MCP server supports OAuth, enter its endpoints under Advanced.",
  })
}
