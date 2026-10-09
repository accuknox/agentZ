"use server"

import { revalidatePath } from "next/cache"
import {
  changeOAuthApplication,
  saveOAuthApplication,
  setOrganizationDelegation,
} from "@/data/delegations"
import { z } from "zod"
import type { oauthApplicationInput } from "@/data/schema"
import { isAPIError } from "better-auth/api"

export async function saveApplicationAction(
  organizationId: string,
  input: z.input<typeof oauthApplicationInput>,
  clientId?: string
) {
  try {
    const result = await saveOAuthApplication(organizationId, input, clientId)
    revalidatePath("/orgs", "layout")
    return result
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues.map((issue) => issue.message).join("\n") }
    }
    let message = "The application could not be saved."
    if (error instanceof Error && error.message) message = error.message
    if (isAPIError(error)) {
      const body = z
        .object({ error_description: z.string().optional() })
        .safeParse(error.body ?? {})
      if (body.success && body.data.error_description) message = body.data.error_description
    }
    return { error: message }
  }
}

export async function changeApplicationAction(
  organizationId: string,
  clientId: string,
  operation: "delete" | "rotate" | "disable" | "enable"
) {
  try {
    const result = await changeOAuthApplication(organizationId, clientId, operation)
    revalidatePath("/orgs", "layout")
    return result
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "The application could not be updated.",
    }
  }
}

export async function delegationSettingAction(organizationId: string, enabled: boolean) {
  try {
    await setOrganizationDelegation(organizationId, enabled)
    revalidatePath("/orgs", "layout")
    return { enabled }
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message ? error.message : "The setting could not be saved.",
    }
  }
}
