import { eq } from "drizzle-orm"
import { metadataResponse } from "@better-auth/oauth-provider"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

let publicRequests = 0

/** handleAuthRequest adds credential-free CORS only to public OAuth token APIs. */
async function handleAuthRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === "/api/auth/.well-known/openid-configuration") {
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      })
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { Allow: "GET, OPTIONS" } })
    const response = metadataResponse({
      ...(await getAuth().api.getOpenIdConfig()),
      claims_parameter_supported: false,
    })
    response.headers.set("Access-Control-Allow-Origin", "*")
    return response
  }
  if (path === "/api/auth/.well-known/jwks.json") {
    const response =
      request.method === "OPTIONS"
        ? new Response(null, { status: 204 })
        : await getAuth().handler(request)
    response.headers.set("Access-Control-Allow-Origin", "*")
    response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")
    return response
  }
  const publicEndpoint = [
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/userinfo",
    "/api/auth/oauth2/revoke",
  ].includes(path)
  const origin = request.headers.get("origin")
  if (!publicEndpoint || !origin) return getAuth().handler(request)
  // Preflights reach this boundary before the provider's endpoint rate limits.
  if (publicRequests >= 64)
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: { "Retry-After": "1", Vary: "Origin" } }
    )
  publicRequests++
  try {
    const clients = await getDB()
      .select({
        redirects: schema.oauthClients.redirectUris,
        disabled: schema.oauthClients.disabled,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.applicationType, "web"))
    const allowed = clients.some(
      (client) => !client.disabled && client.redirects.some((uri) => new URL(uri).origin === origin)
    )
    if (!allowed)
      return Response.json(
        { error: "access_denied", error_description: "This application origin is not registered." },
        { status: 403, headers: { Vary: "Origin" } }
      )
    const response =
      request.method === "OPTIONS"
        ? new Response(null, { status: 204 })
        : await getAuth().handler(request)
    response.headers.append("Vary", "Origin")
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
    response.headers.set("Access-Control-Max-Age", "300")
    return response
  } finally {
    publicRequests--
  }
}

export { handleAuthRequest as GET, handleAuthRequest as POST, handleAuthRequest as OPTIONS }
