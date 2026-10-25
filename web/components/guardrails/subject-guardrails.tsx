"use client"

import { useId, useState, useTransition } from "react"
import { ArrowDown, ArrowUp, FlaskConical, LockKeyhole } from "lucide-react"
import type {
  GuardrailAssignment,
  GuardrailEffective,
  GuardrailPolicy,
  GuardrailSettings,
} from "@/lib/gateway/client"
import { resolveGuardrailsAction, type GuardrailActionScope } from "@/data/guardrail.actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"

const statusVariants = { Ready: "success", Error: "destructive", Pending: "pending" } as const
const statusLabels = { Ready: "Configured", Error: "Error", Pending: "Applying" }

type SubjectGuardrailsProps = {
  assignment: GuardrailAssignment
  disabled?: boolean
  policies: GuardrailPolicy[]
  settings: GuardrailSettings
  scope: GuardrailActionScope
  onChange: (assignment: GuardrailAssignment) => void
}

export function SubjectGuardrails(props: SubjectGuardrailsProps) {
  const { assignment, disabled = false, policies, settings, scope, onChange } = props

  const idPrefix = useId()
  const [effective, setEffective] = useState<GuardrailEffective>()
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()
  const selected = assignment.policies ?? []
  const mandatory = settings.mandatoryPolicies.map((name) => ({
    name,
    policy: policies.find((policy) => policy.scope === "Organisation" && policy.name === name),
  }))
  const available = policies
    .filter((policy) => !policy.mandatory)
    .sort((left, right) => {
      const leftIndex = selected.findIndex(
        (ref) => ref.name === left.name && ref.scope === left.scope
      )
      const rightIndex = selected.findIndex(
        (ref) => ref.name === right.name && ref.scope === right.scope
      )
      if (leftIndex === -1) return rightIndex === -1 ? 0 : 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
  const missing = selected.filter(
    (ref) => !policies.some((policy) => policy.name === ref.name && policy.scope === ref.scope)
  )

  return (
    <FieldGroup>
      <FieldSet className="min-w-0 gap-0">
        <FieldLegend>Required policies</FieldLegend>
        <FieldDescription className="mb-3">
          These run first and cannot be removed here.
        </FieldDescription>
        {mandatory.length ? (
          mandatory.map(({ name, policy }) => (
            <div className="flex flex-wrap items-center justify-between gap-2 py-3" key={name}>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <LockKeyhole aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 break-words">{policy?.displayName ?? name}</span>
              </div>
              <Badge variant={policy ? "secondary" : "destructive"}>
                {policy ? "Required" : "Required, unavailable"}
              </Badge>
            </div>
          ))
        ) : (
          <FieldDescription>No organization baseline is configured.</FieldDescription>
        )}
      </FieldSet>
      {missing.map((ref) => (
        <Alert key={`${ref.scope}/${ref.name}`} variant="destructive">
          <AlertTitle>Selected policy unavailable</AlertTitle>
          <AlertDescription>
            <p>
              {ref.scope} / {ref.name} is unavailable. Remove the reference or restore access before
              saving.
            </p>
            {!disabled ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  onChange({
                    ...assignment,
                    policies: selected.filter(
                      (item) => item.scope !== ref.scope || item.name !== ref.name
                    ),
                  })
                  setEffective(undefined)
                }}
              >
                Remove unavailable reference
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ))}
      <FieldSet className="min-w-0 gap-0">
        <FieldLegend>Additional policies</FieldLegend>
        <FieldDescription className="mb-3">
          Selected policies run in the order shown.
        </FieldDescription>
        {available.length ? (
          available.map((policy) => {
            const selectedIndex = selected.findIndex(
              (ref) => ref.name === policy.name && ref.scope === policy.scope
            )
            const checked = selectedIndex !== -1
            return (
              <Field
                className="py-3 data-[selected=true]:bg-muted/20"
                data-selected={checked}
                key={`${policy.scope}/${policy.name}`}
                orientation="horizontal"
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled || pending}
                  id={`${idPrefix}-policy-${policy.scope}-${policy.name}`}
                  onCheckedChange={(value) => {
                    onChange({
                      ...assignment,
                      policies: value
                        ? [...selected, { name: policy.name, scope: policy.scope }]
                        : selected.filter(
                            (ref) => ref.name !== policy.name || ref.scope !== policy.scope
                          ),
                    })
                    setEffective(undefined)
                  }}
                />
                <FieldContent className="min-w-0">
                  <FieldLabel
                    className="block max-w-full min-w-0 break-words"
                    htmlFor={`${idPrefix}-policy-${policy.scope}-${policy.name}`}
                  >
                    {policy.displayName}
                  </FieldLabel>
                  <FieldDescription className="break-words">
                    {policy.description ||
                      `${policy.checks.length} ${policy.checks.length === 1 ? "check" : "checks"}`}
                    {policy.scope === "Organisation" ? " · Organization" : ""}
                  </FieldDescription>
                </FieldContent>
                <Badge variant={statusVariants[policy.status.state]}>
                  {statusLabels[policy.status.state]}
                </Badge>
                {checked && selected.length > 1 ? (
                  <div className="flex shrink-0 gap-1">
                    {([-1, 1] as const).map((direction) => (
                      <Button
                        aria-label={`Move ${policy.displayName} ${direction === -1 ? "up" : "down"}`}
                        disabled={
                          disabled ||
                          pending ||
                          (direction === -1
                            ? selectedIndex === 0
                            : selectedIndex === selected.length - 1)
                        }
                        key={direction}
                        onClick={() => {
                          const targetIndex = selectedIndex + direction
                          const target = selected[targetIndex]
                          if (!target) return
                          const refs = [...selected]
                          refs[selectedIndex] = target
                          refs[targetIndex] = { name: policy.name, scope: policy.scope }
                          onChange({ ...assignment, policies: refs })
                          setEffective(undefined)
                        }}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        {direction === -1 ? <ArrowUp /> : <ArrowDown />}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </Field>
            )
          })
        ) : (
          <FieldDescription>
            No additional policies available. Create one or ask an administrator to share an
            organization policy.
          </FieldDescription>
        )}
      </FieldSet>
      <FieldDescription>
        Guardrail events retain metadata for {settings.retentionDays} days. Conversation storage is
        managed separately.
      </FieldDescription>
      <Button
        className="self-start"
        disabled={pending}
        onClick={() => {
          setError("")
          startTransition(async () => {
            const result = await resolveGuardrailsAction(scope, { assignment })
            if (result.error) {
              setError(result.error.message)
              return
            }
            setEffective(result.data)
          })
        }}
        type="button"
        variant="outline"
      >
        <FlaskConical data-icon="inline-start" />
        {pending ? "Resolving…" : "Preview effective checks"}
      </Button>
      {effective ? (
        <div className="flex flex-col gap-3 pt-5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Effective checks</h3>
            <Badge variant="secondary">{effective.checks.length}</Badge>
            <span className="text-xs text-muted-foreground">Unsaved preview</span>
          </div>
          {effective.checks.length ? (
            <ol className="flex list-inside list-decimal flex-col gap-2 text-sm">
              {effective.checks.map((item) => (
                <li className="break-words" key={`${item.policyId}/${item.check.id}`}>
                  {item.check.name}
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · {item.policyName} · {item.check.phase === "input" ? "Input" : "Output"}
                    {item.mandatory ? " · Required" : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No checks apply.</p>
          )}
          <p className="text-xs text-muted-foreground">Save to apply this selection.</p>
        </div>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldGroup>
  )
}
