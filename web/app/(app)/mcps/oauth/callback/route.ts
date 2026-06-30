import { revalidateTag } from "next/cache"
import { cookies } from "next/headers"
import { agentSecretsTag, mcpsTag, secretsTag } from "@/data/cache"
import { createMcpConnection, putSecret } from "@/lib/gateway/client"
import type { CreateSecretRequest } from "@/lib/gateway/client"
import {
  completeOAuthFlow,
  mcpOAuthCookieName,
  oauthCallbackResultPage,
  oauthCookieOptions,
  openPendingOAuthState,
  type PendingOAuthState,
} from "@/lib/mcp-oauth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

function htmlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  })
}

function clearPendingOAuthCookie(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.set(mcpOAuthCookieName, "", {
    ...oauthCookieOptions(),
    maxAge: 0,
  })
}

function popupFailure(flowId: string, message: string) {
  return htmlResponse(
    oauthCallbackResultPage({
      success: false,
      flowId,
      message,
    })
  )
}

function secretRevocationMetadata(pending: PendingOAuthState) {
  const metadata = pending.discoveryState?.authorizationServerMetadata
  const endpoint = metadata?.revocation_endpoint
  if (!endpoint) {
    return undefined
  }

  const tokenEndpointAuthMethod = metadata.revocation_endpoint_auth_methods_supported?.[0]
  return {
    endpoint,
    ...(tokenEndpointAuthMethod ? { token_endpoint_auth_method: tokenEndpointAuthMethod } : {}),
  }
}

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sealed = cookieStore.get(mcpOAuthCookieName)?.value
  if (!sealed) {
    return htmlResponse(
      "<!doctype html><html><body>OAuth flow could not be completed.</body></html>"
    )
  }

  let pending: PendingOAuthState
  try {
    pending = await openPendingOAuthState(sealed)
  } catch {
    clearPendingOAuthCookie(cookieStore)
    return htmlResponse(
      "<!doctype html><html><body>OAuth flow could not be completed.</body></html>"
    )
  }

  try {
    const authContext = await currentGatewayAuthContext()
    if (
      pending.initiator.organizationId !== authContext.organizationId ||
      pending.initiator.sessionId !== authContext.sessionId ||
      pending.initiator.userId !== authContext.userId
    ) {
      clearPendingOAuthCookie(cookieStore)
      return popupFailure(
        pending.flowId,
        "OAuth flow no longer matches your signed-in session. Start again."
      )
    }

    const result = await completeOAuthFlow({
      pending,
      callbackURL: new URL(request.url),
    })
    if (!result.ok) {
      console.error("mcp oauth completion failed", {
        code: result.error.code,
        flowId: result.error.flowId,
      })
      clearPendingOAuthCookie(cookieStore)
      return popupFailure(pending.flowId, result.error.message)
    }

    if (pending.operation.kind === "create") {
      const createResult = await createMcpConnection({
        body: {
          name: pending.operation.form.name,
          endpoint: pending.operation.form.endpoint,
          auth: result.value.auth,
          credentials: {
            oauth: result.value.credentials,
          },
        },
        client: getGatewayServerClient(),
      })
      if (createResult.error) {
        console.error("mcp oauth connection save failed", {
          flowId: pending.flowId,
          code: createResult.error.code,
        })
        throw new Error("MCP connection could not be saved")
      }

      revalidateTag(mcpsTag, { expire: 0 })
    } else {
      const createResult = await putSecret({
        body: {
          type: "oauth",
          key: pending.operation.secret.key,
          hosts: pending.operation.secret.hosts,
          oauth: {
            provider: pending.operation.secret.provider,
            issuer: pending.operation.form.oauth.issuer,
            authorization_endpoint: pending.operation.form.oauth.authorizationEndpoint,
            token_endpoint: pending.operation.form.oauth.tokenEndpoint ?? "",
            registration_endpoint: pending.operation.form.oauth.registrationEndpoint,
            resource: pending.operation.form.oauth.resource,
            scopes: pending.operation.form.oauth.scopes ?? [],
            credentials: {
              ...result.value.credentials,
              revocation: secretRevocationMetadata(pending),
            },
          },
        } satisfies CreateSecretRequest,
        client: getGatewayServerClient(),
        path: { agentName: pending.operation.secret.agentName },
      })
      if (createResult.error) {
        console.error("oauth secret save failed", {
          flowId: pending.flowId,
          code: createResult.error.code,
        })
        throw new Error("OAuth secret could not be saved")
      }

      revalidateTag(secretsTag, { expire: 0 })
      revalidateTag(agentSecretsTag(pending.operation.secret.agentName), {
        expire: 0,
      })
    }
    clearPendingOAuthCookie(cookieStore)
    return htmlResponse(
      oauthCallbackResultPage({
        success: true,
        flowId: pending.flowId,
        message: result.value.message,
      })
    )
  } catch (error) {
    console.error("mcp oauth callback commit failed", {
      flowId: pending.flowId,
      message: error instanceof Error ? error.message : "unknown error",
    })
    clearPendingOAuthCookie(cookieStore)
    return popupFailure(pending.flowId, "OAuth flow could not be completed.")
  }
}
