import { revalidateTag } from "next/cache"
import { cookies } from "next/headers"
import { mcpsTag } from "@/data/cache"
import {
  createMcpConnection,
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

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sealed = cookieStore.get(mcpOAuthCookieName())?.value
  if (!sealed) {
    return htmlResponse(
      oauthCallbackResultPage({
        success: false,
        message: "OAuth flow could not be completed.",
      })
    )
  }

  let pending: Awaited<ReturnType<typeof openPendingOAuthState>>
  try {
    pending = await openPendingOAuthState(sealed)
  } catch {
    return htmlResponse(
      oauthCallbackResultPage({
        success: false,
        message: "OAuth flow could not be completed.",
      })
    )
  }

  try {
    const result = await completeOAuthFlow({
      pending,
      callbackURL: new URL(request.url),
    })

    if (pending.operation.kind === "create") {
      const createResult = await createMcpConnection({
        body: {
          name: pending.operation.form.name,
          endpoint: pending.operation.form.endpoint,
          auth: result.auth,
        },
      })
      if (createResult.error) {
        throw new Error(createResult.error.message)
      }

      const credentialsResult = await setMcpConnectionCredentials({
        path: { name: pending.operation.form.name },
        body: {
          oauth: result.credentials,
        },
      })
      if (credentialsResult.error) {
        throw new Error(credentialsResult.error.message)
      }
    } else {
      const updateResult = await updateMcpConnection({
        path: { name: pending.operation.name },
        body: {
          endpoint: pending.operation.form.endpoint,
          auth: result.auth,
        },
      })
      if (updateResult.error) {
        throw new Error(updateResult.error.message)
      }

      const credentialsResult = await setMcpConnectionCredentials({
        path: { name: pending.operation.name },
        body: {
          oauth: result.credentials,
        },
      })
      if (credentialsResult.error) {
        throw new Error(credentialsResult.error.message)
      }
    }

    revalidateTag(mcpsTag, { expire: 0 })
    cookieStore.delete(mcpOAuthCookieName())
    return htmlResponse(
      oauthCallbackResultPage({
        success: true,
        flowId: pending.flowId,
        message: "OAuth flow completed.",
      })
    )
  } catch (error) {
    cookieStore.set(mcpOAuthCookieName(), "", {
      ...oauthCookieOptions(),
      maxAge: 0,
    })
    return htmlResponse(
      oauthCallbackResultPage({
        success: false,
        flowId: pending.flowId,
        message: error instanceof Error ? error.message : "OAuth flow could not be completed.",
      })
    )
  }
}
