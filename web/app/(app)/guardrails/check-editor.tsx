"use client"

import { useId, useState } from "react"
import { flushSync } from "react-dom"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Regex, Trash2 } from "lucide-react"
import type { GuardrailCheck, GuardrailConnection } from "@/lib/gateway/client"
import type { GuardrailActionScope } from "@/data/guardrail.actions"
import { GuardrailProviderResources } from "./provider-resources"
import { GuardrailProviderIcon, guardrailProviderLabels } from "./provider-shared"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const contentScopes = [
  { value: "instructions", label: "System instructions", icon: Regex },
  { value: "conversation", label: "Conversation", icon: Regex },
  { value: "toolResults", label: "Tool results", icon: Regex },
  { value: "toolArguments", label: "Tool arguments", icon: Regex },
] satisfies { value: GuardrailCheck["scopes"][number]; label: string; icon: typeof Regex }[]

const regexPresets = [
  { value: "Email", label: "Email addresses", icon: Regex },
  { value: "PhoneNumber", label: "Phone numbers", icon: Regex },
  { value: "Ssn", label: "US Social Security numbers", icon: Regex },
  { value: "CreditCard", label: "Credit card numbers", icon: Regex },
  { value: "CaSin", label: "Canadian Social Insurance Numbers", icon: Regex },
] satisfies {
  value: NonNullable<NonNullable<GuardrailCheck["regex"]>["builtins"]>[number]
  label: string
  icon: typeof Regex
}[]

type CheckEditorProps = {
  check: GuardrailCheck
  connections: GuardrailConnection[]
  disabled: boolean
  reorderable: boolean
  expanded: boolean
  index: number
  scope: GuardrailActionScope
  validationVisible: boolean
  onChange: (check: GuardrailCheck) => void
  onExpandedChange: (open: boolean) => void
  onRemove: () => void
}

export function CheckEditor(props: CheckEditorProps) {
  const {
    check,
    connections,
    disabled,
    reorderable,
    expanded,
    index,
    scope,
    validationVisible,
    onChange,
    onExpandedChange,
    onRemove,
  } = props

  const { setNodeRef, setActivatorNodeRef, transform, transition, attributes, listeners } =
    useSortable({ id: check.id, disabled: disabled || !reorderable })
  const [advanced, setAdvanced] = useState(false)
  const connection = connections.find(
    (item) => item.name === check.connection?.name && item.scope === check.connection.scope
  )
  const defaultScopes =
    check.phase === "output" || check.regex || connection?.provider === "Bedrock"
      ? ["conversation"]
      : ["instructions", "conversation"]
  const customScopes =
    check.scopes.length !== defaultScopes.length ||
    check.scopes.some((scope) => !defaultScopes.includes(scope))
  const id = useId()
  let detector = ""
  if (check.connection) detector = `${check.connection.scope}/${check.connection.name}`
  if (check.regex) detector = "regex"
  let action = check.action === "mask" ? "mask" : "enforce"
  if (check.mode === "audit") action = "audit"
  let actionDescription = ""
  if (!check.regex)
    actionDescription =
      "The provider controls detection and may modify content as part of enforcement."
  if (check.regex && check.action === "mask")
    actionDescription = "Matched text uses the gateway's standard redaction."
  if (check.mode === "audit")
    actionDescription = "Records findings without blocking or changing content."

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition,
      }}
      data-expanded={expanded || undefined}
      className="-mx-4 border-b px-4 transition-colors last:border-b-0 data-[expanded]:bg-primary/5 motion-reduce:transition-none"
    >
      <details
        className="group/check"
        open={expanded}
        onInvalidCapture={() => flushSync(() => onExpandedChange(true))}
        onToggle={(event) => {
          if (event.target === event.currentTarget) onExpandedChange(event.currentTarget.open)
        }}
      >
        <summary className="group/summary flex cursor-pointer list-none items-center gap-3 py-3 transition-colors marker:hidden hover:bg-muted/35 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
          {disabled || !reorderable ? (
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
            >
              {check.regex ? (
                <Regex className="size-4" />
              ) : connection ? (
                <GuardrailProviderIcon provider={connection.provider} />
              ) : null}
            </span>
          ) : (
            <Button
              ref={setActivatorNodeRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              className="group/grip relative size-8 shrink-0 cursor-grab touch-none bg-primary/10 text-primary active:cursor-grabbing"
              aria-label={`Reorder check ${index + 1}`}
              {...attributes}
              {...listeners}
              onClick={(event) => event.stopPropagation()}
            >
              <span className="flex group-hover/summary:opacity-0 group-focus-visible/grip:opacity-0 group-aria-pressed/grip:opacity-0">
                {check.regex ? (
                  <Regex />
                ) : connection ? (
                  <GuardrailProviderIcon provider={connection.provider} />
                ) : null}
              </span>
              <GripVertical className="absolute opacity-0 group-hover/summary:opacity-100 group-focus-visible/grip:opacity-100 group-aria-pressed/grip:opacity-100" />
            </Button>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium">
              {check.name ||
                (check.regex ? "Regex check" : connection?.displayName || "Provider check")}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex shrink-0 items-center gap-1">
                {check.phase === "input" ? (
                  <ArrowDown aria-hidden className="size-3" />
                ) : (
                  <ArrowUp aria-hidden className="size-3" />
                )}
                {check.phase === "input" ? "Model input" : "Model output"}
              </span>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <span className="max-w-48 truncate">
                {check.regex
                  ? "Regex"
                  : (connection?.displayName ?? check.connection?.name ?? "Checker")}
              </span>
              {check.mode === "enforce" && check.action !== "mask" ? (
                <Badge variant={check.regex ? "destructive" : "secondary"}>
                  {check.regex ? "Block" : "Enforce"}
                </Badge>
              ) : null}
              {check.mode === "audit" ? <Badge variant="secondary">Audit</Badge> : null}
              {check.mode === "enforce" && check.action === "mask" ? (
                <Badge variant="secondary">Mask</Badge>
              ) : null}
              {check.mode === "enforce" && check.failureMode === "open" ? (
                <Badge variant="warning">Fail open</Badge>
              ) : null}
              {customScopes ? <Badge variant="secondary">Custom scope</Badge> : null}
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 group-open/check:rotate-180 motion-reduce:transition-none"
          />
          {!disabled ? (
            <Button
              aria-label={`Delete ${check.name || "check"}`}
              size="icon-sm"
              type="button"
              variant="destructive"
              onClick={(event) => {
                event.stopPropagation()
                onRemove()
              }}
            >
              <Trash2 />
            </Button>
          ) : null}
        </summary>
        <div className="pt-1 pb-4 motion-safe:group-open/check:animate-in motion-safe:group-open/check:duration-150 motion-safe:group-open/check:fade-in motion-safe:group-open/check:slide-in-from-top-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`} required>
                Check name
              </FieldLabel>
              <Input
                disabled={disabled}
                id={`${id}-name`}
                maxLength={128}
                placeholder="e.g. Block sensitive identifiers"
                onChange={(event) => onChange({ ...check, name: event.target.value })}
                required
                value={check.name}
              />
            </Field>
            <FieldGroup>
              {connections.length > 0 || check.connection ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-detector`}>Detection method</FieldLabel>
                  <Select
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (value === "regex") {
                        onChange({
                          ...check,
                          connection: undefined,
                          regex: { patterns: [] },
                          guardrailId: undefined,
                          guardrailVersion: undefined,
                          template: undefined,
                        })
                        return
                      }
                      const selected = connections.find(
                        (item) => `${item.scope}/${item.name}` === value
                      )
                      if (selected)
                        onChange({
                          ...check,
                          regex: undefined,
                          connection: { scope: selected.scope, name: selected.name },
                          action: "deny",
                          guardrailId: undefined,
                          guardrailVersion: undefined,
                          template: undefined,
                          phase: selected.provider === "OpenAI" ? "input" : check.phase,
                          scopes:
                            selected.provider === "Bedrock" ||
                            (check.phase === "output" && selected.provider !== "OpenAI")
                              ? ["conversation"]
                              : ["instructions", "conversation"],
                        })
                    }}
                    value={detector}
                  >
                    <SelectTrigger id={`${id}-detector`} className="w-full">
                      <SelectValue placeholder="Select a checker connection" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="regex">
                          <Regex aria-hidden />
                          Regular expression
                        </SelectItem>
                        {check.connection && !connection ? (
                          <SelectItem value={`${check.connection.scope}/${check.connection.name}`}>
                            {check.connection.scope} / {check.connection.name}
                          </SelectItem>
                        ) : null}
                        {connections.map((item) => (
                          <SelectItem
                            key={`${item.scope}/${item.name}`}
                            value={`${item.scope}/${item.name}`}
                          >
                            <GuardrailProviderIcon provider={item.provider} />
                            {item.displayName} · {guardrailProviderLabels[item.provider]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              {check.regex ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${id}-presets`}>Presets</FieldLabel>
                    <MultiSelectDropdown
                      id={`${id}-presets`}
                      aria-label="Regex presets"
                      disabled={disabled}
                      options={regexPresets}
                      value={check.regex.builtins ?? []}
                      placeholder="Select presets"
                      searchPlaceholder="Search presets..."
                      onValueChangeAction={(builtins) => {
                        const selected = regexPresets.filter((preset) =>
                          builtins.includes(preset.value)
                        )
                        onChange({
                          ...check,
                          regex: {
                            ...check.regex,
                            builtins: selected.map((preset) => preset.value),
                          },
                        })
                      }}
                    />
                    {check.regex.builtins?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {check.regex.builtins.map((builtin) => (
                          <Badge key={builtin} variant="secondary" className="gap-1 pr-1 pl-2.5">
                            {regexPresets.find((preset) => preset.value === builtin)?.label}
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              disabled={disabled}
                              aria-label={`Remove ${builtin} preset`}
                              onClick={() =>
                                onChange({
                                  ...check,
                                  regex: {
                                    ...check.regex,
                                    builtins: check.regex?.builtins?.filter(
                                      (value) => value !== builtin
                                    ),
                                  },
                                })
                              }
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-patterns`}>Custom expressions</FieldLabel>
                    <Textarea
                      className="min-h-24 font-mono text-sm"
                      disabled={disabled}
                      id={`${id}-patterns`}
                      onChange={(event) =>
                        onChange({
                          ...check,
                          regex: { ...check.regex, patterns: event.target.value.split("\n") },
                        })
                      }
                      placeholder={"e.g. confidential\ninternal-only"}
                      required={!check.regex.builtins?.length}
                      value={check.regex.patterns?.join("\n") ?? ""}
                    />
                    <FieldDescription>
                      One expression per line. Presets and expressions are checked together.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              ) : null}
              {disabled && check.connection && !connection ? (
                <FieldDescription>
                  Referenced connection: {check.connection.scope} / {check.connection.name}.
                  {check.guardrailId ? (
                    <span className="block">Guardrail ID: {check.guardrailId}</span>
                  ) : null}
                  {check.guardrailVersion ? (
                    <span className="block">Guardrail version: {check.guardrailVersion}</span>
                  ) : null}
                  {check.template ? (
                    <span className="block">Template: {check.template}</span>
                  ) : null}
                </FieldDescription>
              ) : null}
              {connection ? (
                <GuardrailProviderResources
                  check={check}
                  connection={connection}
                  disabled={disabled}
                  key={`${connection.scope}/${connection.name}`}
                  onChange={onChange}
                  scope={scope}
                  validationVisible={validationVisible}
                />
              ) : null}
            </FieldGroup>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-phase`}>Run on</FieldLabel>
                <Select
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value !== "input" && value !== "output") return
                    let scopes = check.scopes
                    if (!check.regex)
                      scopes =
                        connection?.provider === "Bedrock"
                          ? ["conversation"]
                          : ["instructions", "conversation"]
                    if (value === "output") scopes = ["conversation"]
                    onChange({ ...check, phase: value, scopes })
                  }}
                  value={check.phase}
                >
                  <SelectTrigger id={`${id}-phase`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="input">Model input</SelectItem>
                      <SelectItem disabled={connection?.provider === "OpenAI"} value="output">
                        Model output
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor={`${id}-action`}>
                  {check.regex ? "On a match" : "On a finding"}
                </FieldLabel>
                <Select
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value === "audit") onChange({ ...check, mode: "audit" })
                    if (value === "enforce") onChange({ ...check, mode: "enforce", action: "deny" })
                  }}
                  value={action}
                >
                  <SelectTrigger id={`${id}-action`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="enforce">Enforce</SelectItem>
                      {check.action === "mask" ? (
                        <SelectItem disabled value="mask">
                          Mask (existing configuration)
                        </SelectItem>
                      ) : null}
                      <SelectItem value="audit">Audit only</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {actionDescription ? (
                  <FieldDescription>{actionDescription}</FieldDescription>
                ) : null}
              </Field>
            </div>
            <Accordion
              collapsible
              type="single"
              value={advanced ? "advanced" : ""}
              onInvalidCapture={() => flushSync(() => setAdvanced(true))}
              onValueChange={(value) => setAdvanced(value === "advanced")}
            >
              <AccordionItem value="advanced">
                <AccordionTrigger>Advanced settings</AccordionTrigger>
                <AccordionContent forceMount hidden={!advanced}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor={`${id}-scopes`}>Inspected content</FieldLabel>
                      {check.phase === "input" ? (
                        <MultiSelectDropdown
                          id={`${id}-scopes`}
                          aria-label="Inspected content"
                          options={contentScopes}
                          value={check.scopes}
                          disabled={
                            disabled || (!check.regex && connection?.provider !== "Bedrock")
                          }
                          placeholder="Select content"
                          onValueChangeAction={(selected) =>
                            onChange({
                              ...check,
                              scopes: contentScopes
                                .filter((scope) => selected.includes(scope.value))
                                .map((scope) => scope.value),
                            })
                          }
                        />
                      ) : (
                        <FieldDescription>Conversation output.</FieldDescription>
                      )}
                      {connection?.provider === "Bedrock" &&
                      check.phase === "input" &&
                      check.scopes.includes("instructions") ? (
                        <FieldDescription>
                          Prompt-attack filters may flag trusted system instructions.
                        </FieldDescription>
                      ) : null}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-failure`}>If the checker fails</FieldLabel>
                      <Select
                        disabled={disabled}
                        onValueChange={(value) => {
                          if (value === "closed" || value === "open")
                            onChange({ ...check, failureMode: value })
                        }}
                        value={check.failureMode}
                      >
                        <SelectTrigger id={`${id}-failure`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="closed">Stop request</SelectItem>
                            <SelectItem value="open">Allow request</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        Applies to checker errors and timeouts, including audit checks. Audit
                        findings do not block requests.
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-explanation`}>Message when blocked</FieldLabel>
                      <Textarea
                        disabled={disabled}
                        id={`${id}-explanation`}
                        maxLength={512}
                        onChange={(event) =>
                          onChange({ ...check, safeExplanation: event.target.value })
                        }
                        placeholder="e.g. Remove API keys from your message."
                        value={check.safeExplanation ?? ""}
                      />
                      <FieldDescription>Keep sensitive details out.</FieldDescription>
                    </Field>
                  </FieldGroup>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </FieldGroup>
        </div>
      </details>
    </div>
  )
}
