import "server-only"

import { cache } from "react"
import { eq } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"

export const themePreferences = ["system", "light", "dark"] as const

export type ThemePreference = (typeof themePreferences)[number]

export type UserPreferences = {
  theme: ThemePreference
  updateSandbox: boolean
}

/**
 * defaultUserPreferences provides the app-wide default preference values.
 */
const defaultUserPreferences: UserPreferences = {
  theme: "system",
  updateSandbox: false,
}

/**
 * getCurrentUserPreferences returns the current user's saved preferences.
 *
 * Authentication remains request-bound while sharing the session lookup with
 * the surrounding organization layout.
 */
export const getCurrentUserPreferences = cache(
  async ({
    required = true,
  }: {
    required?: boolean
  } = {}): Promise<UserPreferences> => {
    const authSession = await getAuthSession()
    if (!authSession) {
      if (!required) {
        return defaultUserPreferences
      }

      throw new Error("unauthorized")
    }
    const { session } = authSession

    const [row] = await getDB()
      .select({
        theme: schema.userPreferences.theme,
        updateSandbox: schema.userPreferences.updateSandbox,
      })
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, session.user.id))
      .limit(1)

    return {
      theme: row?.theme ?? defaultUserPreferences.theme,
      updateSandbox: row?.updateSandbox ?? defaultUserPreferences.updateSandbox,
    }
  }
)

/**
 * saveCurrentUserPreferences upserts the current user's saved preferences.
 */
export async function saveCurrentUserPreferences(
  preferences: UserPreferences
): Promise<UserPreferences> {
  const authSession = await getAuthSession()
  if (!authSession) {
    throw new Error("unauthorized")
  }
  const { session } = authSession

  await getDB()
    .insert(schema.userPreferences)
    .values({
      userId: session.user.id,
      theme: preferences.theme,
      updateSandbox: preferences.updateSandbox,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: {
        theme: preferences.theme,
        updateSandbox: preferences.updateSandbox,
        updatedAt: new Date(),
      },
    })

  return preferences
}
