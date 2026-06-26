"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import type { DeleteSessionFormState } from "@/data/types"
import { getAuth } from "@/lib/auth"

export async function deleteSessionFormAction(
  _: DeleteSessionFormState,
  formData: FormData
): Promise<DeleteSessionFormState> {
  const auth = getAuth()
  const token = formData.get("token")
  if (typeof token !== "string" || token.length === 0) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid session token",
      },
    }
  }

  const requestHeaders = await headers()
  const currentSession = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!currentSession) {
    return {
      error: {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      },
    }
  }

  if (currentSession.session.token === token) {
    return {
      error: {
        code: "CURRENT_SESSION",
        message: "The current session cannot be revoked.",
      },
    }
  }

  try {
    await auth.api.revokeSession({
      headers: requestHeaders,
      body: { token },
    })
  } catch (error) {
    return {
      error: {
        code: "SESSION_DELETE_FAILED",
        message: error instanceof Error ? error.message : "Failed to revoke session",
      },
    }
  }

  redirect("/settings/sessions")
}
