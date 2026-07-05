"use server"

import * as z from "zod"
import { saveCurrentUserPreferences, type UserPreferences } from "@/data/user-preferences"

const preferencesFormSchema = z.object({
  updateSandbox: z.stringbool(),
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
      updateSandbox: parsed.data.updateSandbox,
    })
    return { preferences }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save preferences",
      preferences: state.preferences,
    }
  }
}
