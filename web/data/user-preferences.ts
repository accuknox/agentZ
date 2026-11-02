import "server-only"

import { cache } from "react"
import { eq } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { dayjs } from "@/lib/format"

export const themePreferences = ["system", "light", "dark"] as const

export type ThemePreference = (typeof themePreferences)[number]

export type UserPreferences = Pick<
  typeof schema.userPreferences.$inferSelect,
  | "theme"
  | "updateSandbox"
  | "showTourButton"
  | "showReasoningAndTools"
  | "followUpBehavior"
  | "hideLeftNavScrollbar"
>

/**
 * defaultUserPreferences provides the app-wide default preference values.
 */
const defaultUserPreferences: UserPreferences = {
  theme: "system",
  followUpBehavior: "steer",
  updateSandbox: false,
  showTourButton: true,
  hideLeftNavScrollbar: false,
  showReasoningAndTools: true,
}

// Root and page layouts share the read even when sign-in requirements differ.
const readCurrentUserPreferences = cache(async (): Promise<UserPreferences | null> => {
  const authSession = await getAuthSession()
  if (!authSession) return null
  const [row] = await getDB()
    .select({
      theme: schema.userPreferences.theme,
      followUpBehavior: schema.userPreferences.followUpBehavior,
      updateSandbox: schema.userPreferences.updateSandbox,
      showTourButton: schema.userPreferences.showTourButton,
      hideLeftNavScrollbar: schema.userPreferences.hideLeftNavScrollbar,
      showReasoningAndTools: schema.userPreferences.showReasoningAndTools,
    })
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, authSession.session.user.id))
    .limit(1)

  return row ?? defaultUserPreferences
})

/** getCurrentUserPreferences returns the signed-in user's saved preferences. */
export async function getCurrentUserPreferences({
  required = true,
}: { required?: boolean } = {}): Promise<UserPreferences> {
  const preferences = await readCurrentUserPreferences()
  if (preferences) return preferences
  if (required) throw new Error("unauthorized")
  return defaultUserPreferences
}

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
      ...preferences,
      userId: session.user.id,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: {
        ...preferences,
        updatedAt: dayjs().toDate(),
      },
    })

  return preferences
}
