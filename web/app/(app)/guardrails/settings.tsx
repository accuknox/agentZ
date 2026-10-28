"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowUp, BrickWallShield, CircleAlert, Save } from "lucide-react"
import { toast } from "sonner"
import type { GuardrailPolicy, GuardrailSettings } from "@/lib/gateway/client"
import { saveGuardrailSettingsAction } from "@/data/guardrail.actions"
import { LoadingButton } from "@/components/interior/loading-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"

type GuardrailOrganizationSettingsProps = {
  initial: GuardrailSettings
  policies: GuardrailPolicy[]
}

export function GuardrailOrganizationSettings(props: GuardrailOrganizationSettingsProps) {
  const { initial, policies } = props

  const router = useRouter()
  const [settings, setSettings] = useState(initial)
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()
  const organizationPolicies = policies.filter((policy) => policy.scope === "Organisation")

  return (
    <form
      className="flex max-w-4xl min-w-0 flex-col gap-8 px-4 pb-6 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        startTransition(async () => {
          const result = await saveGuardrailSettingsAction(settings)
          if (result.error) {
            setError(result.error.message)
            return
          }
          toast.success("Organization guardrail settings saved")
          router.refresh()
        })
      }}
    >
      <FieldSet className="gap-5">
        <FieldLegend className="font-semibold">Organization baseline</FieldLegend>
        <FieldDescription>
          Selected policies protect every managed request, including external applications and CLI
          agents. Workspaces cannot remove them.
        </FieldDescription>
        <MultiSelectDropdown
          aria-label="Organization baseline policies"
          disabled={pending}
          emptyMessage="No organization policies found."
          placeholder="Select baseline policies"
          searchPlaceholder="Search policies..."
          options={organizationPolicies.map((policy) => ({
            icon: BrickWallShield,
            label: policy.displayName,
            value: policy.name,
            badge: `${policy.checks.length} ${policy.checks.length === 1 ? "check" : "checks"}`,
            description: policy.description || undefined,
          }))}
          value={settings.mandatoryPolicies}
          onValueChangeAction={(selected) => {
            // The shared picker sorts selections; baseline execution order must stay intact.
            setSettings((current) => ({
              ...current,
              mandatoryPolicies: [
                ...current.mandatoryPolicies.filter((name) => selected.includes(name)),
                ...selected.filter((name) => !current.mandatoryPolicies.includes(name)),
              ],
            }))
          }}
        />
        {organizationPolicies.length === 0 ? (
          <FieldDescription>
            Create an organization policy before adding it to the required baseline.
          </FieldDescription>
        ) : null}
      </FieldSet>
      {settings.mandatoryPolicies.length > 1 ? (
        <FieldSet>
          <FieldLegend variant="label">Baseline execution order</FieldLegend>
          {settings.mandatoryPolicies.map((name, index) => (
            <div className="flex items-center justify-between gap-2" key={name}>
              <span className="text-sm">
                {index + 1}. {policies.find((policy) => policy.name === name)?.displayName ?? name}
              </span>
              <div className="flex gap-1">
                {([-1, 1] as const).map((direction) => (
                  <Button
                    aria-label={`Move ${name} ${direction === -1 ? "up" : "down"}`}
                    disabled={
                      pending ||
                      (direction === -1
                        ? index === 0
                        : index === settings.mandatoryPolicies.length - 1)
                    }
                    key={direction}
                    onClick={() => {
                      const values = [...settings.mandatoryPolicies]
                      const target = values[index + direction]
                      if (!target) return
                      values[index] = target
                      values[index + direction] = name
                      setSettings({ ...settings, mandatoryPolicies: values })
                    }}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    {direction === -1 ? <ArrowUp /> : <ArrowDown />}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </FieldSet>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Settings not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="-mx-4 flex w-[100cqw] justify-end border-t px-4 pt-6 md:-mx-6 md:px-6">
        <LoadingButton pending={pending} pendingLabel="Saving..." type="submit">
          <Save data-icon="inline-start" />
          Save settings
        </LoadingButton>
      </div>
    </form>
  )
}
