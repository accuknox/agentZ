"use client"

import * as React from "react"
import { toast } from "sonner"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun, CircleAlert } from "lucide-react"
import type { ThemePreference } from "@/data/user-preferences"
import { SegmentedControl } from "@/components/interior/segmented-control"
import { Switch } from "@/components/ui/switch"
import { savePreferencesAction, type PreferencesFormState } from "./actions"
import { Alert, AlertDescription } from "@/components/ui/alert"

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
      try {
        const result = await savePreferencesAction(state, formData)
        if (result.saved) toast.success("Preferences updated", { id: "preferences-updated" })
        return result
      } catch {
        return {
          error: "Could not save preferences. Try again.",
          preferences: state.preferences,
        }
      }
    },
    initialState
  )
  const [preferences, setPreferences] = React.useOptimistic(state.preferences)

  React.useEffect(() => {
    setTheme(preferences.theme)
  }, [preferences.theme, setTheme])

  function updatePreferences(next: PreferencesFormState["preferences"]) {
    const formData = new FormData()
    formData.set("theme", next.theme)
    formData.set("updateSandbox", String(next.updateSandbox))
    formData.set("showTourButton", String(next.showTourButton))
    formData.set("showReasoningAndTools", String(next.showReasoningAndTools))

    React.startTransition(() => {
      setPreferences(next)
      action(formData)
    })
  }

  return (
    <section className="flex flex-col gap-2 px-4 pb-6 md:px-6">
      <div className="flex items-start justify-between gap-6 py-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-normal">Theme</h2>
          <p className="text-sm text-muted-foreground">We save this choice to your account.</p>
        </div>
        <SegmentedControl<ThemePreference>
          label="Theme"
          className="shrink-0"
          disabled={pending}
          value={preferences.theme}
          onValueChange={(theme) => updatePreferences({ ...preferences, theme })}
          options={[
            {
              value: "system",
              label: (
                <>
                  <Monitor />
                  <span className="sr-only sm:not-sr-only">System</span>
                </>
              ),
            },
            {
              value: "light",
              label: (
                <>
                  <Sun />
                  <span className="sr-only sm:not-sr-only">Light</span>
                </>
              ),
            },
            {
              value: "dark",
              label: (
                <>
                  <Moon />
                  <span className="sr-only sm:not-sr-only">Dark</span>
                </>
              ),
            },
          ]}
        />
      </div>

      <div className="flex items-start justify-between gap-6 py-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-normal">
            Auto-accept allowed host suggestions
          </h2>
          <p className="text-sm text-muted-foreground">
            Automatically add secret hosts to the agent sandbox when creating a secret.
          </p>
        </div>
        <Switch
          aria-label="Update sandbox when creating secrets"
          checked={preferences.updateSandbox}
          disabled={pending}
          onCheckedChange={(updateSandbox) => updatePreferences({ ...preferences, updateSandbox })}
        />
      </div>
      <div className="flex items-start justify-between gap-6 py-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-base font-semibold tracking-normal" htmlFor="show-tour-button">
            Show tour button
          </label>
          <p className="text-sm text-muted-foreground" id="show-tour-description">
            Show the &quot;Take a tour&quot; button in the sidebar.
          </p>
        </div>
        <Switch
          id="show-tour-button"
          aria-describedby="show-tour-description"
          checked={preferences.showTourButton}
          disabled={pending}
          onCheckedChange={(showTourButton) =>
            updatePreferences({ ...preferences, showTourButton })
          }
        />
      </div>
      <div className="flex items-start justify-between gap-6 py-2">
        <div className="min-w-0 space-y-1">
          <label className="text-base font-semibold tracking-normal" htmlFor="show-chat-activity">
            Show reasoning and tool calls
          </label>
          <p className="text-sm text-muted-foreground" id="chat-activity-description">
            Show expandable reasoning and tool activity in chats. Always enabled in coding
            workspaces.
          </p>
        </div>
        <Switch
          id="show-chat-activity"
          aria-describedby="chat-activity-description"
          checked={preferences.showReasoningAndTools}
          disabled={pending}
          onCheckedChange={(showReasoningAndTools) =>
            updatePreferences({ ...preferences, showReasoningAndTools })
          }
        />
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
