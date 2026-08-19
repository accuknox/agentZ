"use client"

import * as React from "react"
import type { FieldError as RHFFieldError } from "react-hook-form"
import { Plus, X } from "lucide-react"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { secretHostSchema } from "@/data/schema"

type SecretHostsFieldProps = {
  name: string
  value: string
  inputRef: React.Ref<HTMLInputElement>
  onBlur: () => void
  onChange: (value: string) => void
  invalid: boolean
  error?: RHFFieldError
  inputID: string
}

export function SecretHostsField({
  name,
  value,
  inputRef,
  onBlur,
  onChange,
  invalid,
  error,
  inputID,
}: SecretHostsFieldProps) {
  const [draft, setDraft] = React.useState("")
  const [draftError, setDraftError] = React.useState<string>()
  const hosts = value
    .split("\n")
    .map((host) => host.trim())
    .filter(Boolean)

  function addHost() {
    const parsed = secretHostSchema.safeParse(draft)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? "Host is invalid")
      return
    }

    const nextHosts = Array.from(new Set([...hosts, parsed.data])).sort()
    setDraft("")
    setDraftError(undefined)
    onChange(nextHosts.join("\n"))
  }

  function removeHost(host: string) {
    onChange(hosts.filter((item) => item !== host).join("\n"))
  }

  return (
    <Field data-invalid={invalid || Boolean(draftError)}>
      <FieldLabel htmlFor={inputID} required>
        Hosts
      </FieldLabel>
      <FieldDescription className="text-muted-foreground/80">
        Add an exact host, IP address, or CIDR range. `*.` matches one subdomain label; `**.`
        matches any depth.
      </FieldDescription>
      <input type="hidden" name={name} ref={inputRef} value={value} readOnly />
      <InputGroup className="h-9">
        <InputGroupInput
          id={inputID}
          value={draft}
          onBlur={onBlur}
          onChange={(event) => {
            setDraft(event.target.value)
            setDraftError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return
            }
            event.preventDefault()
            addHost()
          }}
          placeholder="api.example.com, *.example.com, **.example.com, 10.0.0.0/24"
          className="font-mono"
          aria-invalid={invalid || Boolean(draftError)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={addHost} aria-label="Add host">
            <Plus />
            Add
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {hosts.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          {hosts.map((host) => (
            <div
              key={host}
              className="flex h-8 items-center justify-between gap-3 border-b px-2.5 last:border-b-0"
            >
              <span className="truncate font-mono text-sm">{host}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm transition-colors"
                onClick={() => removeHost(host)}
                aria-label={`Remove ${host}`}
              >
                <X data-icon="inline-end" size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {draftError ? <FieldError errors={[{ message: draftError }]} /> : null}
      {invalid && error ? <FieldError errors={[error]} /> : null}
    </Field>
  )
}
