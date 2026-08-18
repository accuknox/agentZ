import { handleOAuthDiscovery } from "@/lib/mcp-oauth-discovery"

export function POST(request: Request) {
  return handleOAuthDiscovery(request, {
    endpointLabel: "OAuth server URL",
    manualMessage:
      "Auto-discovery failed. If this OAuth server supports discovery, fill in the required fields in advanced manually.",
  })
}
