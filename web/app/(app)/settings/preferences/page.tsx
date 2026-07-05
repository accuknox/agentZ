import type { Metadata } from "next"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { PreferencesForm } from "./preferences-form"

export const metadata: Metadata = {
  title: "Preferences",
}

export default async function PreferencesPage() {
  const preferences = await getCurrentUserPreferences()

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Preferences</h1>
        </div>
      </div>
      <PreferencesForm
        initialState={{
          preferences,
        }}
      />
    </main>
  )
}
