"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { PutSecretFormState } from "@/data/types"
import { secretFormInputSchema, secretHostSchema } from "@/data/schema"
import type * as z from "zod"
import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type SecretFormValues = z.infer<typeof secretFormInputSchema>

type PutSecretAction = (
  agentName: string,
  state: PutSecretFormState,
  formData: FormData
) => Promise<PutSecretFormState>

export function SecretSheet({
  agentName,
  mode,
  secretKey,
  hosts,
  putSecretAction,
  open,
  onOpenChangeAction,
}: {
  agentName: string
  mode: "create" | "update"
  secretKey?: string
  hosts?: string[]
  putSecretAction: PutSecretAction
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}) {
  const [state, action, isPending] = React.useActionState(putSecretAction.bind(null, agentName), {})
  const [hostDraft, setHostDraft] = React.useState("")
  const [hostDraftError, setHostDraftError] = React.useState<string>()

  const form = useForm<SecretFormValues>({
    resolver: zodResolver(secretFormInputSchema),
    defaultValues: {
      key: secretKey ?? "",
      value: "",
      hosts: hosts?.join("\n") ?? "",
    },
  })

  React.useEffect(() => {
    if (!isPending && !state.error) {
      form.reset()
      onOpenChangeAction(false)
    }
  }, [isPending, state.error, onOpenChangeAction, form])

  React.useEffect(() => {
    if (open) {
      const nextHosts = hosts ?? []
      form.reset({
        key: secretKey ?? "",
        value: "",
        hosts: nextHosts.join("\n"),
      })
    }
  }, [open, secretKey, hosts, form])

  React.useEffect(() => {
    if (state.error?.errors) {
      for (const err of state.error.errors) {
        if (err.field === "key" || err.field === "value" || err.field === "hosts") {
          form.setError(err.field, { type: "server", message: err.message })
        }
      }
    }
  }, [state.error, form])

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    if (hostDraft.trim() !== "") {
      setHostDraftError("Add or clear the host before submitting")
      return
    }

    await action(formData)
  }

  function addHost() {
    const parsed = secretHostSchema.safeParse(hostDraft)
    if (!parsed.success) {
      setHostDraftError(parsed.error.issues[0]?.message ?? "Host is invalid")
      return
    }

    const host = parsed.data
    const hosts = parseHostsValue(form.getValues("hosts"))
    const nextHosts = Array.from(new Set([...hosts, host])).sort()
    setHostDraft("")
    setHostDraftError(undefined)
    form.setValue("hosts", nextHosts.join("\n"), {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.clearErrors("hosts")
  }

  function removeHost(host: string) {
    const hosts = parseHostsValue(form.getValues("hosts"))
    const nextHosts = hosts.filter((item) => item !== host)
    form.setValue("hosts", nextHosts.join("\n"), {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setHostDraft("")
      setHostDraftError(undefined)
    }
    onOpenChangeAction(nextOpen)
  }

  const title = mode === "create" ? "New secret" : "Update secret"
  const description =
    mode === "create"
      ? "Create a new secret for this agent. Secret values cannot be read after creation."
      : `Override the value for "${secretKey}". The previous value will be permanently replaced.`
  const submitLabel = mode === "create" ? "Create secret" : "Update secret"
  const generalErrorMessage = (() => {
    if (!state.error) {
      return undefined
    }

    const fieldErrors =
      state.error.errors?.filter(
        (error) => error.field === "key" || error.field === "value" || error.field === "hosts"
      ) ?? []
    const hasGeneralError = !state.error.errors || state.error.errors.length > fieldErrors.length

    return hasGeneralError ? state.error.message : undefined
  })()

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      <SheetContent className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <form action={submitAction} className="flex flex-1 flex-col gap-4 p-4">
          <input type="hidden" name="mode" value={mode} />
          <FieldGroup>
            <Controller
              name="key"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="secret-key">Name</FieldLabel>
                  <Input
                    id="secret-key"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="SECRET_NAME"
                    readOnly={mode === "update"}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              name="hosts"
              control={form.control}
              render={({ field, fieldState }) => {
                const hostList = parseHostsValue(field.value)

                return (
                  <Field data-invalid={fieldState.invalid || Boolean(hostDraftError)}>
                    <FieldLabel htmlFor="secret-hosts">Hosts</FieldLabel>
                    <FieldDescription className="text-muted-foreground/80">
                      Exact host, wildcard host, IP, or CIDR. Wildcards match subdomains.
                    </FieldDescription>
                    <input type="hidden" name={field.name} ref={field.ref} value={field.value} />
                    <InputGroup className="h-9">
                      <InputGroupInput
                        id="secret-hosts"
                        value={hostDraft}
                        onBlur={field.onBlur}
                        onChange={(event) => {
                          setHostDraft(event.target.value)
                          setHostDraftError(undefined)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") {
                            return
                          }
                          event.preventDefault()
                          addHost()
                        }}
                        placeholder="api.example.com, *.example.com, 10.0.0.0/24"
                        className="font-mono"
                        aria-invalid={fieldState.invalid || Boolean(hostDraftError)}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton onClick={addHost} aria-label="Add host">
                          <Plus />
                          Add
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    {hostList.length > 0 ? (
                      <div className="overflow-hidden rounded-md border">
                        {hostList.map((host) => (
                          <div
                            key={host}
                            className="flex h-8 items-center justify-between gap-3 border-b px-2.5 last:border-b-0"
                          >
                            <span className="truncate font-mono text-sm">{host}</span>
                            <button
                              type="button"
                              className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                              onClick={() => removeHost(host)}
                              aria-label={`Remove ${host}`}
                            >
                              <X data-icon="inline-end" size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {hostDraftError ? <FieldError errors={[{ message: hostDraftError }]} /> : null}
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )
              }}
            />
            <Controller
              name="value"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="secret-value">Value</FieldLabel>
                  <Textarea
                    id="secret-value"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="Enter secret value..."
                    className="min-h-32 resize-y font-mono"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
          {generalErrorMessage ? (
            <p className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {generalErrorMessage}
            </p>
          ) : null}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending} className="w-full">
              {isPending ? <Spinner /> : null}
              {isPending ? (mode === "create" ? "Creating..." : "Updating...") : submitLabel}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function parseHostsValue(value: string) {
  return value
    .split("\n")
    .map((host) => host.trim())
    .filter(Boolean)
}
