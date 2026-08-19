import type { Metadata } from "next"
import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { getCurrentUserPreferences } from "@/data/user-preferences"
import { PreferencesForm } from "./preferences-form"

export const metadata: Metadata = {
  title: "Preferences",
}

export default function PreferencesPage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="Preferences" />
      <Suspense fallback={<PreferencesSkeleton />}>
        <Preferences />
      </Suspense>
    </main>
  )
}

async function Preferences() {
  const preferences = await getCurrentUserPreferences()

  return (
    <PreferencesForm
      initialState={{
        preferences,
      }}
    />
  )
}

function PreferencesSkeleton() {
  return (
    <section className="px-4 md:px-6">
      <div className="flex items-start justify-between gap-4 py-1">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="bg-muted/20 h-5 w-72 rounded-md" />
          <div className="bg-muted/20 h-4 max-w-lg rounded-md" />
        </div>
        <div className="bg-muted/20 h-6 w-11 shrink-0 rounded-full" />
      </div>
    </section>
  )
}
