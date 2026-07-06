import "server-only"

import { eq } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

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
 * The request headers are read first so Cache Components can defer the auth
 * and database setup to request time while prerendering the page shell.
 */
export async function getCurrentUserPreferences({
  required = true,
}: {
  required?: boolean
} = {}): Promise<UserPreferences> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    if (!required) {
      return defaultUserPreferences
    }

    throw new Error("unauthorized")
  }

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

/**
 * saveCurrentUserPreferences upserts the current user's saved preferences.
 */
export async function saveCurrentUserPreferences(
  preferences: UserPreferences
): Promise<UserPreferences> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    throw new Error("unauthorized")
  }

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
