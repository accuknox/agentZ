"use server"

import * as z from "zod"
import { revalidatePath } from "next/cache"
import {
  saveCurrentUserPreferences,
  themePreferences,
  type UserPreferences,
} from "@/data/user-preferences"

const preferencesFormSchema = z.object({
  showReasoningAndTools: z.stringbool({ error: "Chat activity preference is invalid" }).optional(),
  showTourButton: z.stringbool({ error: "Tour preference is invalid" }).optional(),
  theme: z.enum(themePreferences, { error: "Theme preference is invalid" }).optional(),
  updateSandbox: z.stringbool({ error: "Sandbox update preference is invalid" }).optional(),
})

export type PreferencesFormState = {
  error?: string
  preferences: UserPreferences
  saved?: boolean
}

/**
 * savePreferencesAction persists the signed-in user's preferences.
 */
export async function savePreferencesAction(
  state: PreferencesFormState,
  formData: FormData
): Promise<PreferencesFormState> {
  const parsed = preferencesFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      error: "Preferences are invalid.",
      preferences: state.preferences,
    }
  }

  try {
    const preferences = await saveCurrentUserPreferences({
      theme: parsed.data.theme ?? state.preferences.theme,
      showReasoningAndTools:
        parsed.data.showReasoningAndTools ?? state.preferences.showReasoningAndTools,
      showTourButton: parsed.data.showTourButton ?? state.preferences.showTourButton,
      updateSandbox: parsed.data.updateSandbox ?? state.preferences.updateSandbox,
    })
    revalidatePath("/orgs/[orgSlug]/workspaces/[workspaceSlug]", "layout")
    revalidatePath("/settings/preferences")
    return { preferences, saved: true }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save preferences",
      preferences: state.preferences,
    }
  }
}
