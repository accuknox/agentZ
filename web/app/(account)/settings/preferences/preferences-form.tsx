"use client"

import * as React from "react"
import { toast } from "sonner"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"
import type { ThemePreference } from "@/data/user-preferences"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { savePreferencesAction, type PreferencesFormState } from "./actions"

/**
 * PreferencesForm renders autosaved user preferences.
 */
export function PreferencesForm({
  initialState,
}: {
  initialState: PreferencesFormState
}): React.JSX.Element {
  const { setTheme } = useTheme()
  const [state, action, pending] = React.useActionState(
    async (state: PreferencesFormState, formData: FormData) => {
      const result = await savePreferencesAction(state, formData)
      if (result.saved) toast.success("Preferences updated")
      return result
    },
    initialState
  )
  const [draft, setDraft] = React.useState(initialState.preferences)
  const preferences = pending ? draft : state.preferences

  function updatePreferences(next: PreferencesFormState["preferences"]) {
    setDraft(next)

    const formData = new FormData()
    formData.set("theme", next.theme)
    formData.set("updateSandbox", String(next.updateSandbox))

    React.startTransition(() => {
      action(formData)
    })
  }

  function onThemeChange(theme: ThemePreference) {
    setTheme(theme)
    updatePreferences({
      ...preferences,
      theme,
    })
  }

  function onUpdateSandboxChange(updateSandbox: boolean) {
    updatePreferences({
      ...preferences,
      updateSandbox,
    })
  }

  return (
    <section className="flex flex-col gap-2 px-4 pb-6 md:px-6">
      <div className="flex items-start justify-between gap-6 py-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-normal">Theme</h2>
          <p className="text-muted-foreground text-sm">We save this choice to your account.</p>
        </div>
        <Select disabled={pending} onValueChange={onThemeChange} value={preferences.theme}>
          <SelectTrigger aria-label="Theme" className="w-32 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="system">
                <Monitor /> System
              </SelectItem>
              <SelectItem value="light">
                <Sun /> Light
              </SelectItem>
              <SelectItem value="dark">
                <Moon /> Dark
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start justify-between gap-6 py-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-normal">
            Auto-accept allowed host suggestions
          </h2>
          <p className="text-muted-foreground text-sm">
            Automatically add secret hosts to the agent sandbox when creating a secret.
          </p>
          {state.error ? (
            <p className="text-destructive text-sm" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
        <Switch
          aria-label="Update sandbox when creating secrets"
          checked={preferences.updateSandbox}
          disabled={pending}
          onCheckedChange={onUpdateSandboxChange}
        />
      </div>
    </section>
  )
}
