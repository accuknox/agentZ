import "server-only"

import { eq } from "drizzle-orm"
import { headers } from "next/headers"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

export type UserPreferences = {
  updateSandbox: boolean
}

/**
 * getCurrentUserPreferences returns the current user's saved preferences.
 *
 * The request headers are read first so Cache Components can defer the auth
 * and database setup to request time while prerendering the page shell.
 */
export async function getCurrentUserPreferences(): Promise<UserPreferences> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (!session) {
    throw new Error("unauthorized")
  }

  const [row] = await getDB()
    .select({
      updateSandbox: schema.userPreferences.updateSandbox,
    })
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, session.user.id))
    .limit(1)

  return {
    updateSandbox: row?.updateSandbox ?? false,
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
      updateSandbox: preferences.updateSandbox,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: {
        updateSandbox: preferences.updateSandbox,
        updatedAt: new Date(),
      },
    })

  return preferences
}
