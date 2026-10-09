import { and, eq } from "drizzle-orm"
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
  if (!publicEndpoint) return getAuth().handler(request)
  const preflight = request.method === "OPTIONS"
  const vary = preflight
    ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    : "Origin"
  if (origin === null) {
    const response = await getAuth().handler(request)
    response.headers.append("Vary", vary)
    return response
  }
  // Preflights reach this boundary before the provider's endpoint rate limits.
  if (publicRequests >= 64)
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: { "Retry-After": "1", Vary: vary } }
    )
  publicRequests++
  try {
    const [registered] = await getDB()
      .select({ origin: schema.oauthClientOrigins.origin })
      .from(schema.oauthClientOrigins)
      .innerJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.oauthClientOrigins.clientId)
      )
      .where(
        and(
          eq(schema.oauthClientOrigins.origin, origin),
          eq(schema.oauthClients.applicationType, "web"),
          eq(schema.oauthClients.tokenEndpointAuthMethod, "none"),
          eq(schema.oauthClients.disabled, false)
        )
      )
      .limit(1)
    if (!registered)
      return Response.json(
        { error: "access_denied", error_description: "This application origin is not registered." },
        { status: 403, headers: { Vary: vary } }
      )
    const methods = path.endsWith("/userinfo") ? ["GET", "POST"] : ["POST"]
    const requestedMethod = request.headers.get("access-control-request-method")
    const requestedHeaders = request.headers.get("access-control-request-headers")
    const permittedHeaders =
      !requestedHeaders ||
      requestedHeaders
        .split(",")
        .every((header) => ["authorization", "content-type"].includes(header.trim().toLowerCase()))
    let response: Response
    if (!preflight) response = await getAuth().handler(request)
    else if (!requestedMethod || !methods.includes(requestedMethod) || !permittedHeaders)
      response = Response.json(
        { error: "access_denied", error_description: "Unsupported CORS method or headers." },
        { status: 403 }
      )
    else response = new Response(null, { status: 204 })
    response.headers.append("Vary", vary)
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After")
    if (preflight) {
      response.headers.set("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "))
      response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
      response.headers.set("Access-Control-Max-Age", "300")
    }
    return response
  } catch (error) {
    console.error("OAuth CORS request failed", error)
    return Response.json(
      { error: "temporarily_unavailable" },
      {
        status: 503,
        headers: { "Retry-After": "1", Vary: vary },
      }
    )
  } finally {
    publicRequests--
  }
}

export { handleAuthRequest as GET, handleAuthRequest as POST, handleAuthRequest as OPTIONS }
