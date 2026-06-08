import { revalidateTag } from "next/cache"
import { cookies } from "next/headers"
import { mcpsTag } from "@/data/cache"
import {
  createMcpConnection,
  deleteMcpConnection,
  getMcpConnection,
  setMcpConnectionCredentials,
  updateMcpConnection,
} from "@/lib/gateway/client"
import {
  completeOAuthFlow,
  mcpOAuthCookieName,
  oauthCallbackResultPage,
  oauthCookieOptions,
  openPendingOAuthState,
} from "@/lib/mcp-oauth"

function htmlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
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
        },
      })
      if (createResult.error) {
        throw new Error(createResult.error.message)
      }

      const credentialsResult = await setMcpConnectionCredentials({
        path: { name: pending.operation.form.name },
        body: {
          oauth: result.value.credentials,
        },
      })
      if (credentialsResult.error) {
        const deleteResult = await deleteMcpConnection({
          path: { name: pending.operation.form.name },
        })
        if (deleteResult.error) {
          console.error("mcp oauth create compensation failed", {
            flowId: pending.flowId,
            code: deleteResult.error.code,
          })
        }
        throw new Error(credentialsResult.error.message)
      }
    } else {
      const currentResult = await getMcpConnection({
        path: { name: pending.operation.name },
        cache: "no-store",
      })
      if (currentResult.error) {
        throw new Error(currentResult.error.message)
      }

      const previous = currentResult.data
      const updateResult = await updateMcpConnection({
        path: { name: pending.operation.name },
        body: {
          endpoint: pending.operation.form.endpoint,
          auth: result.value.auth,
        },
      })
      if (updateResult.error) {
        throw new Error(updateResult.error.message)
      }

      const credentialsResult = await setMcpConnectionCredentials({
        path: { name: pending.operation.name },
        body: {
          oauth: result.value.credentials,
        },
      })
      if (credentialsResult.error) {
        const rollbackResult = await updateMcpConnection({
          path: { name: pending.operation.name },
          body: {
            endpoint: previous.endpoint,
            auth: previous.auth,
          },
        })
        if (rollbackResult.error) {
          console.error("mcp oauth update rollback failed", {
            flowId: pending.flowId,
            code: rollbackResult.error.code,
          })
        }
        throw new Error(credentialsResult.error.message)
      }
    }

    revalidateTag(mcpsTag, { expire: 0 })
    cookieStore.delete(mcpOAuthCookieName())
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
