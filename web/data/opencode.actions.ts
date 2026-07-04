"use server"

import { isRedirectError } from "next/dist/client/components/redirect-error"
import * as z from "zod"
import { createAgentOpencodeClient } from "@/lib/opencode/server-client"
import type { DeleteSessionFormState } from "@/data/types"

const deleteOpencodeSessionFormSchema = z.object({
  sessionID: z.string().min(1),
})

// deleteAgentSessionAction deletes one OpenCode session for a single agent.
export async function deleteAgentSessionAction(
  agentName: string,
  _: DeleteSessionFormState,
  formData: FormData
): Promise<DeleteSessionFormState> {
  const parsed = deleteOpencodeSessionFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_FORM",
        message: "Invalid session ID",
      },
      success: false,
    }
  }

  try {
    const client = await createAgentOpencodeClient(agentName)
    const result = await client.session.delete({
      path: { id: parsed.data.sessionID },
    })

    if (!result.data) {
      return {
        error: {
          code: "OPENCODE_SESSION_DELETE_ERROR",
          message: "Failed to delete session",
        },
        success: false,
      }
    }

    return {
      error: undefined,
      success: true,
    }
  } catch (err) {
    if (isRedirectError(err)) {
      throw err
    }

    return {
      error: {
        code: "OPENCODE_SESSION_DELETE_ERROR",
        message: err instanceof Error ? err.message : "Failed to delete session",
      },
      success: false,
    }
  }
}
