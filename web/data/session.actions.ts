"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import * as z from "zod"
import type { DeleteSessionFormState } from "@/data/types"
import { getAuth } from "@/lib/auth"
import { signInURL } from "@/lib/sign-in-redirect"

const deleteSessionFormSchema = z.object({
  token: z.string().min(1),
})

export async function deleteSessionFormAction(
  _: DeleteSessionFormState,
  formData: FormData
): Promise<DeleteSessionFormState> {
  const parsed = deleteSessionFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid session token",
      },
    }
  }

  const requestHeaders = await headers()
  const auth = getAuth()
  const currentSession = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!currentSession) {
    redirect(signInURL({ error: "session_expired" }))
  }

  if (currentSession.session.token === parsed.data.token) {
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
      body: { token: parsed.data.token },
    })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }

    return {
      error: {
        code: "SESSION_DELETE_FAILED",
        message: "Failed to revoke session",
      },
    }
  }

  redirect("/settings/sessions")
}
