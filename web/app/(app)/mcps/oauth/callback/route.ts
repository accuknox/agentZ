import { revalidateTag } from "next/cache"
import { cookies } from "next/headers"
import { mcpsTag } from "@/data/cache"
import { createMcpConnection } from "@/lib/gateway/client"
import {
  completeOAuthFlow,
  mcpOAuthCookieName,
  oauthCallbackResultPage,
  oauthCookieOptions,
  openPendingOAuthState,
} from "@/lib/mcp-oauth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { gatewayServerClient } from "@/lib/gateway/server-client"

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
  cookieStore.set(mcpOAuthCookieName(), "", {
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

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sealed = cookieStore.get(mcpOAuthCookieName())?.value
  if (!sealed) {
    return htmlResponse(
      "<!doctype html><html><body>OAuth flow could not be completed.</body></html>"
    )
  }

  let pending: Awaited<ReturnType<typeof openPendingOAuthState>>
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

    const createResult = await createMcpConnection({
      body: {
        name: pending.operation.form.name,
        endpoint: pending.operation.form.endpoint,
        auth: result.value.auth,
        credentials: {
          oauth: result.value.credentials,
        },
      },
      client: gatewayServerClient,
    })
    if (createResult.error) {
      throw new Error(createResult.error.message)
    }

    revalidateTag(mcpsTag, { expire: 0 })
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
    return popupFailure(
      pending.flowId,
      error instanceof Error ? error.message : "OAuth flow could not be completed."
    )
  }
}
