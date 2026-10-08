import {
  oauthProviderAuthServerMetadata,
  metadataResponse,
  type ResourceServerMetadata,
} from "@better-auth/oauth-provider"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"

export async function GET(request: Request) {
  let response: Response
  const path = new URL(request.url).pathname
  if (path === "/.well-known/oauth-authorization-server")
    response = await oauthProviderAuthServerMetadata(getAuth())(request)
  else if (path === "/.well-known/openid-configuration")
    response = metadataResponse({
      ...(await getAuth().api.getOpenIdConfig()),
      claims_parameter_supported: false,
    })
  else {
    const resources = new Map([
      [
        "/.well-known/oauth-protected-resource/api/inference/v1",
        { path: "/api/inference/v1", scopes: ["inference:use"] },
      ],
      ["/.well-known/oauth-protected-resource/api/mcp", { path: "/api/mcp", scopes: ["mcp:use"] }],
    ])
    const resource = resources.get(path)
    if (!resource) return new Response(null, { status: 404 })
    const issuer = getEnv().BETTER_AUTH_URL
    response = metadataResponse({
      resource: `${issuer}${resource.path}`,
      authorization_servers: [issuer],
      scopes_supported: resource.scopes,
      bearer_methods_supported: ["header"],
      resource_name: "AgentZ",
    } satisfies ResourceServerMetadata)
  }
  response.headers.set("Access-Control-Allow-Origin", "*")
  return response
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  })
}
