"use client"

import { useId } from "react"
import { ArrowDown, ArrowUp, BrickWallShield, LockKeyhole, X } from "lucide-react"
import type { GuardrailAssignment, GuardrailPolicy, GuardrailSettings } from "@/lib/gateway/client"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"

type SubjectGuardrailsProps = {
  assignment: GuardrailAssignment
  disabled?: boolean
  policies: GuardrailPolicy[]
  settings: GuardrailSettings
  onChange: (assignment: GuardrailAssignment) => void
}

export function SubjectGuardrails(props: SubjectGuardrailsProps) {
  const { assignment, disabled = false, policies, settings, onChange } = props

  const id = useId()
  const mandatory = settings.mandatoryPolicies.map((name) => ({
    name,
    policy: policies.find((policy) => policy.scope === "Organisation" && policy.name === name),
  }))
  const mandatoryKeys = mandatory.map(({ name }) => `Organisation/${name}`)
  const selected = (assignment.policies ?? []).filter(
    (ref) => !mandatoryKeys.includes(`${ref.scope}/${ref.name}`)
  )
  const available = policies.filter(
    (policy) => !policy.mandatory && !mandatoryKeys.includes(`${policy.scope}/${policy.name}`)
  )
  const missing = selected.filter(
    (ref) => !policies.some((policy) => policy.name === ref.name && policy.scope === ref.scope)
  )

  return (
    <FieldGroup className="min-w-0 gap-6">
      {missing.map((ref) => (
        <Alert key={`${ref.scope}/${ref.name}`} variant="destructive">
          <AlertTitle className="wrap-anywhere">{ref.name} is unavailable</AlertTitle>
          <AlertDescription>
            <p>Remove this policy or restore access before saving.</p>
            {!disabled ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onChange({
                    ...assignment,
                    policies: selected.filter(
                      (item) => item.scope !== ref.scope || item.name !== ref.name
                    ),
                  })
                }}
              >
                Remove policy
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ))}
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor={id}>
          <BrickWallShield aria-hidden className="size-4 text-primary" />
          Policies
        </FieldLabel>
        <MultiSelectDropdown
          disabled={disabled}
          emptyMessage="No policies found."
          id={id}
          options={[
            ...mandatory.map(({ name, policy }) => ({
              icon: LockKeyhole,
              label: policy?.displayName ?? name,
              value: `Organisation/${name}`,
              group: "Organization baseline",
              badge: policy ? "Required" : "Unavailable",
              disabled: true,
            })),
            ...available.map((policy) => ({
              icon: BrickWallShield,
              label: policy.displayName,
              value: `${policy.scope}/${policy.name}`,
              group: policy.scope === "Organisation" ? "Organization" : "Workspace",
              badge: `${policy.checks.length} ${policy.checks.length === 1 ? "check" : "checks"}`,
              description: policy.description || undefined,
            })),
            ...missing.map((ref) => ({
              icon: BrickWallShield,
              label: ref.name,
              value: `${ref.scope}/${ref.name}`,
              badge: "Unavailable",
              disabled: true,
            })),
          ]}
          placeholder="Select policies"
          searchPlaceholder="Search policies..."
          value={[...mandatoryKeys, ...selected.map((ref) => `${ref.scope}/${ref.name}`)]}
          onValueChangeAction={(values) => {
            // The picker sorts values; keep existing execution order and append new policies.
            onChange({
              ...assignment,
              policies: [
                ...selected.filter((ref) => values.includes(`${ref.scope}/${ref.name}`)),
                ...available
                  .filter(
                    (policy) =>
                      values.includes(`${policy.scope}/${policy.name}`) &&
                      !selected.some(
                        (ref) => ref.name === policy.name && ref.scope === policy.scope
                      )
                  )
                  .map((policy) => ({ name: policy.name, scope: policy.scope })),
              ],
            })
          }}
        />
        {selected.length > 1 ? (
          <FieldDescription>Policies run in the order below.</FieldDescription>
        ) : null}
        {selected.length > 1 ? (
          <ol aria-label="Policy execution order" className="flex min-w-0 flex-col gap-1">
            {selected.map((ref, index) => {
              const policy = policies.find(
                (policy) => policy.name === ref.name && policy.scope === ref.scope
              )
              if (!policy) return null
              return (
                <li
                  className="flex min-w-0 items-center gap-2 py-2"
                  key={`${ref.scope}/${ref.name}`}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/5 text-primary">
                    <BrickWallShield aria-hidden className="size-4" />
                  </span>
                  <span className="w-5 shrink-0 text-sm text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium wrap-anywhere">{policy.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {policy.checks.length} {policy.checks.length === 1 ? "check" : "checks"}
                      {" · "}
                      {policy.scope === "Organisation" ? "Organization" : "Workspace"}
                    </span>
                    {policy.status.state !== "Ready" ? (
                      <Badge
                        className="self-start"
                        variant={policy.status.state === "Error" ? "destructive" : "pending"}
                      >
                        {policy.status.state === "Error" ? "Error" : "Applying"}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center">
                    {([-1, 1] as const).map((direction) => (
                      <Button
                        aria-label={`Move ${policy.displayName} ${direction === -1 ? "up" : "down"}`}
                        disabled={
                          disabled ||
                          (direction === -1 ? index === 0 : index === selected.length - 1)
                        }
                        key={direction}
                        onClick={() => {
                          const targetIndex = index + direction
                          const target = selected[targetIndex]
                          if (!target) return
                          const refs = [...selected]
                          refs[index] = target
                          refs[targetIndex] = ref
                          onChange({ ...assignment, policies: refs })
                        }}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        {direction === -1 ? <ArrowUp /> : <ArrowDown />}
                      </Button>
                    ))}
                    <Button
                      aria-label={`Remove ${policy.displayName}`}
                      disabled={disabled}
                      onClick={() =>
                        onChange({
                          ...assignment,
                          policies: selected.filter(
                            (item) => item.name !== ref.name || item.scope !== ref.scope
                          ),
                        })
                      }
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ol>
        ) : null}
      </Field>
    </FieldGroup>
  )
}
