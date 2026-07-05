"use client"

import * as React from "react"
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
  const [draftChecked, setDraftChecked] = React.useState(initialState.preferences.updateSandbox)
  const [state, action, pending] = React.useActionState(savePreferencesAction, initialState)
  const checked = pending ? draftChecked : state.preferences.updateSandbox

  function onCheckedChange(nextChecked: boolean) {
    setDraftChecked(nextChecked)

    const formData = new FormData()
    formData.set("updateSandbox", String(nextChecked))

    React.startTransition(() => {
      action(formData)
    })
  }

  return (
    <section className="px-4 md:px-6">
      <div className="flex items-start justify-between gap-4 py-1">
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
          checked={checked}
          disabled={pending}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </section>
  )
}
