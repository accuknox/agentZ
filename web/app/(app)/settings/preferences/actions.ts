"use server"

import * as z from "zod"
import {
  saveCurrentUserPreferences,
  themePreferences,
  type UserPreferences,
} from "@/data/user-preferences"

const preferencesFormSchema = z.object({
  theme: z.enum(themePreferences, { error: "Theme preference is invalid" }).optional(),
  updateSandbox: z.stringbool({ error: "Sandbox update preference is invalid" }).optional(),
})

export type PreferencesFormState = {
  error?: string
  preferences: UserPreferences
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
      updateSandbox: parsed.data.updateSandbox ?? state.preferences.updateSandbox,
    })
    return { preferences }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save preferences",
      preferences: state.preferences,
    }
  }
}
