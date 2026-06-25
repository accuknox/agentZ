"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { KeyRound } from "lucide-react"
import { createAPIKeyFormSchema, type CreateAPIKeyFormValues } from "@/data/api-key.schema"
import type { CreateAPIKeyFormState } from "@/data/types"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { Agent } from "@/lib/gateway/client"

type APIKeyScopeMode = CreateAPIKeyFormValues["scopeMode"]

const apiKeyExpiryOptions = [
  { label: "No expiry", value: "none" },
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "365 days", value: "365" },
] satisfies Array<{
  label: string
  value: CreateAPIKeyFormValues["expiresInDays"]
}>

export function CreateAPIKeyButton({
  agents,
  createAPIKeyAction,
}: {
  agents: Agent[]
  createAPIKeyAction: (
    state: CreateAPIKeyFormState,
    formData: FormData
  ) => Promise<CreateAPIKeyFormState>
}) {
  const [open, setOpen] = React.useState(false)
  const [dialogKey, setDialogKey] = React.useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setDialogKey((value) => value + 1)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <KeyRound data-icon="inline-start" />
          New API key
        </Button>
      </DialogTrigger>
      <CreateAPIKeyDialog key={dialogKey} agents={agents} createAPIKeyAction={createAPIKeyAction} />
    </Dialog>
  )
}

function CreateAPIKeyDialog({
  agents,
  createAPIKeyAction,
}: {
  agents: Agent[]
  createAPIKeyAction: (
    state: CreateAPIKeyFormState,
    formData: FormData
  ) => Promise<CreateAPIKeyFormState>
}) {
  const router = useRouter()
  const [state, action, pending] = React.useActionState(createAPIKeyAction, {})
  const form = useForm<CreateAPIKeyFormValues>({
    resolver: zodResolver(createAPIKeyFormSchema),
    defaultValues: {
      name: "",
      expiresInDays: "none",
      scopeMode: "all",
      agentNames: [],
    },
  })
  const agentNames = useWatch({
    control: form.control,
    name: "agentNames",
  })

  React.useEffect(() => {
    if (!state.key) {
      return
    }
    React.startTransition(() => {
      router.refresh()
    })
  }, [router, state.key])

  const submit = async (formData: FormData) => {
    const valid = await form.trigger()
    if (!valid) {
      return
    }

    React.startTransition(() => {
      action(formData)
    })
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{state.key ? "Copy your API key" : "Create API key"}</DialogTitle>
        <DialogDescription>
          {state.key
            ? "This secret is shown once. Store it now."
            : "This key works with OpenCode-compatible clients using username opencode."}
        </DialogDescription>
      </DialogHeader>
      {state.key ? (
        <>
          <div className="flex flex-col gap-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="api-key-created-name">Name</FieldLabel>
                <Input
                  id="api-key-created-name"
                  value={state.key.name ?? "API key"}
                  readOnly
                  disabled
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="api-key-created-secret">API key</FieldLabel>
                <Input id="api-key-created-secret" value={state.key.secret} readOnly />
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter>
            <CopyButton content={state.key.secret} label="Copy" />
            <DialogClose asChild>
              <Button type="button" variant="destructive">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </>
      ) : (
        <>
          <form id="api-key-form" action={submit} className="space-y-5">
            <FieldGroup>
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="api-key-name" required>
                      Name
                    </FieldLabel>
                    <Input
                      id="api-key-name"
                      name={field.name}
                      ref={field.ref}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                      maxLength={32}
                      placeholder="CI"
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="expiresInDays"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="api-key-expiry">Expiry</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                      <SelectTrigger
                        id="api-key-expiry"
                        onBlur={field.onBlur}
                        aria-invalid={fieldState.invalid}
                        className="w-full"
                      >
                        <SelectValue placeholder="No expiry" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {apiKeyExpiryOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="scopeMode"
                control={form.control}
                render={({ field, fieldState }) => {
                  const scopeError = form.formState.errors.agentNames ?? fieldState.error
                  const invalid = !!scopeError

                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="api-key-scope" required>
                        Scope
                      </FieldLabel>
                      <APIKeyScopeInput
                        agents={agents}
                        agentNamesName="agentNames"
                        scopeName={field.name}
                        mode={field.value}
                        selectedAgentNames={agentNames}
                        onBlurAction={field.onBlur}
                        onModeChangeAction={(value) => {
                          field.onChange(value)
                          if (value !== "all") {
                            return
                          }
                          form.setValue("agentNames", [], {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }}
                        onAgentNamesChangeAction={(value) => {
                          form.setValue("agentNames", value, {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                          if (field.value === "selected") {
                            return
                          }
                          field.onChange("selected")
                        }}
                        invalid={invalid}
                      />
                      {scopeError ? <FieldError errors={[scopeError]} /> : null}
                    </Field>
                  )
                }}
              />
            </FieldGroup>
          </form>
          {state.error ? (
            <div role="alert" className="border-destructive/40 rounded border p-3 text-sm">
              <p className="text-destructive font-medium">{state.error.message}</p>
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form="api-key-form" disabled={pending}>
              {pending ? <Spinner aria-hidden="true" /> : <KeyRound data-icon="inline-start" />}
              Create API key
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  )
}

function APIKeyScopeInput({
  agents,
  agentNamesName,
  invalid,
  mode,
  onAgentNamesChangeAction,
  onBlurAction,
  onModeChangeAction,
  scopeName,
  selectedAgentNames,
}: {
  agents: Agent[]
  agentNamesName: string
  invalid: boolean
  mode: APIKeyScopeMode
  onAgentNamesChangeAction: (value: string[]) => void
  onBlurAction: () => void
  onModeChangeAction: (value: APIKeyScopeMode) => void
  scopeName: string
  selectedAgentNames: string[]
}) {
  const options: MultiSelectDropdownOption[] = agents.map((agent) => ({
    label: agent.name,
    value: agent.name,
  }))

  return (
    <div className="flex flex-col gap-3">
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value === "all" || value === "selected") {
            onModeChangeAction(value)
          }
        }}
      >
        <SelectTrigger
          id="api-key-scope"
          onBlur={onBlurAction}
          aria-invalid={invalid}
          aria-required="true"
          className="w-full"
        >
          <SelectValue placeholder="All agents" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All agents</SelectItem>
            <SelectItem value="selected">Selected agents</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <input type="hidden" name={scopeName} value={mode} />
      {mode === "selected" ? (
        <MultiSelectDropdown
          id="api-key-scope-agents"
          invalid={invalid}
          onBlurAction={onBlurAction}
          onValueChangeAction={onAgentNamesChangeAction}
          options={options}
          placeholder="Select agents"
          searchPlaceholder="Search agents..."
          value={selectedAgentNames}
        />
      ) : null}
      {selectedAgentNames.map((agentName) => (
        <input key={agentName} type="hidden" name={agentNamesName} value={agentName} />
      ))}
    </div>
  )
}
