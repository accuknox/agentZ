"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { BotIcon, CheckIcon, KeyRound, Webhook } from "lucide-react"
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from "@/components/ui/multi-select-dropdown"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { Agent, WorkflowSummary } from "@/lib/gateway/client"
import { cn } from "@/lib/utils"

type APIKeyScopeMode = CreateAPIKeyFormValues["scopeMode"]
type WorkflowGroup = {
  agentName: string
  workflows: WorkflowSummary[]
}

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
  workflowsByAgent,
  createAPIKeyAction,
}: {
  agents: Agent[]
  workflowsByAgent: WorkflowGroup[]
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
      <CreateAPIKeyDialog
        key={dialogKey}
        agents={agents}
        workflowsByAgent={workflowsByAgent}
        createAPIKeyAction={createAPIKeyAction}
      />
    </Dialog>
  )
}

function CreateAPIKeyDialog({
  agents,
  workflowsByAgent,
  createAPIKeyAction,
}: {
  agents: Agent[]
  workflowsByAgent: WorkflowGroup[]
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
      type: "agent",
      name: "",
      expiresInDays: "none",
      scopeMode: "all",
      agentNames: [],
      workflowScopes: [],
    },
  })
  const apiKeyType = useWatch({
    control: form.control,
    name: "type",
  })
  const agentNames = useWatch({
    control: form.control,
    name: "agentNames",
  })
  const workflowScopes = useWatch({
    control: form.control,
    name: "workflowScopes",
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
            : apiKeyType === "webhook"
              ? "This key triggers workflow webhooks with the X-API-Key header."
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
                name="type"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="api-key-type" required>
                      Type
                    </FieldLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        if (value !== "agent" && value !== "webhook") {
                          return
                        }
                        field.onChange(value)
                        if (value !== "webhook") {
                          return
                        }
                        form.setValue("scopeMode", "all", {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                        form.setValue("agentNames", [], {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                        form.setValue("workflowScopes", [], {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }}
                      name={field.name}
                    >
                      <SelectTrigger
                        id="api-key-type"
                        onBlur={field.onBlur}
                        aria-invalid={fieldState.invalid}
                        className="w-full"
                      >
                        <SelectValue placeholder="Agent" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="agent">Agent</SelectItem>
                          <SelectItem value="webhook">
                            <Webhook className="inline-block" />
                            Webhook
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
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
              {apiKeyType === "agent" ? (
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
              ) : (
                <Controller
                  name="scopeMode"
                  control={form.control}
                  render={({ field, fieldState }) => {
                    const scopeError = form.formState.errors.workflowScopes ?? fieldState.error
                    const invalid = !!scopeError

                    return (
                      <Field data-invalid={invalid}>
                        <FieldLabel htmlFor="api-key-webhook-scope" required>
                          Scope
                        </FieldLabel>
                        <WebhookScopeInput
                          invalid={invalid}
                          mode={field.value}
                          onBlurAction={field.onBlur}
                          onModeChangeAction={(value) => {
                            field.onChange(value)
                            if (value !== "all") {
                              return
                            }
                            form.setValue("workflowScopes", [], {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }}
                          onWorkflowScopesChangeAction={(value) => {
                            form.setValue("workflowScopes", value, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                            if (field.value === "selected") {
                              return
                            }
                            field.onChange("selected")
                          }}
                          scopeName={field.name}
                          selectedWorkflowScopes={workflowScopes}
                          workflowScopesName="workflowScopes"
                          workflowsByAgent={workflowsByAgent}
                        />
                        {scopeError ? <FieldError errors={[scopeError]} /> : null}
                      </Field>
                    )
                  }}
                />
              )}
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
              {pending ? (
                <Spinner aria-hidden="true" />
              ) : apiKeyType === "webhook" ? (
                <Webhook data-icon="inline-start" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
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

function WebhookScopeInput({
  invalid,
  mode,
  onBlurAction,
  onModeChangeAction,
  onWorkflowScopesChangeAction,
  scopeName,
  selectedWorkflowScopes,
  workflowScopesName,
  workflowsByAgent,
}: {
  invalid: boolean
  mode: APIKeyScopeMode
  onBlurAction: () => void
  onModeChangeAction: (value: APIKeyScopeMode) => void
  onWorkflowScopesChangeAction: (value: string[]) => void
  scopeName: string
  selectedWorkflowScopes: string[]
  workflowScopesName: string
  workflowsByAgent: WorkflowGroup[]
}) {
  const selected = new Set(selectedWorkflowScopes)
  const selectedCount = selectedWorkflowScopes.length
  const triggerLabel =
    selectedCount === 0
      ? "Select workflows"
      : selectedCount <= 2
        ? selectedWorkflowScopes
            .map((scope) => {
              const [, agentName, workflowName] = scope.split(":")
              return workflowName ? `${agentName}/${workflowName}` : ""
            })
            .filter(Boolean)
            .join(", ")
        : `${selectedCount} workflows selected`

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
          id="api-key-webhook-scope"
          onBlur={onBlurAction}
          aria-invalid={invalid}
          aria-required="true"
          className="w-full"
        >
          <SelectValue placeholder="All workflows" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All workflows</SelectItem>
            <SelectItem value="selected">Selected workflows</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <input type="hidden" name={scopeName} value={mode} />
      {mode === "selected" ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              id="api-key-scope-workflows"
              type="button"
              className={cn(
                "border-input focus-visible:border-ring focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3",
                selectedCount === 0 && "text-muted-foreground",
                invalid &&
                  "border-destructive ring-destructive/20 dark:border-destructive/50 focus-visible:ring-destructive/20"
              )}
            >
              <span className="line-clamp-1 text-left">{triggerLabel}</span>
              <span className="text-muted-foreground text-xs">{selectedCount || ""}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--radix-popover-trigger-width) p-0"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              onBlurAction()
            }}
            sideOffset={8}
          >
            <Command>
              <CommandInput
                placeholder="Search workflows..."
                onBlur={onBlurAction}
                aria-invalid={invalid}
                aria-required="true"
              />
              <CommandList className="max-h-80">
                <CommandEmpty>No workflows found.</CommandEmpty>
                {workflowsByAgent
                  .toSorted((left, right) => left.agentName.localeCompare(right.agentName))
                  .map((group) => (
                    <CommandGroup key={group.agentName} className="pt-2">
                      <div className="text-foreground flex items-center gap-2 px-2 pb-1 text-xs font-medium">
                        <BotIcon className="text-primary size-3.5" />
                        <span>{group.agentName}</span>
                      </div>
                      {group.workflows
                        .toSorted((left, right) =>
                          left.workflow_name.localeCompare(right.workflow_name)
                        )
                        .map((workflow) => {
                          const value = `workflow:${group.agentName}:${workflow.workflow_name}`
                          const checked = selected.has(value)

                          return (
                            <CommandItem
                              key={value}
                              value={`${group.agentName} ${workflow.title} ${workflow.workflow_name}`}
                              className="cursor-pointer items-start rounded-md"
                              onMouseDown={(event) => {
                                event.preventDefault()
                              }}
                              onSelect={() => {
                                const nextSelected = new Set(selected)
                                if (checked) {
                                  nextSelected.delete(value)
                                } else {
                                  nextSelected.add(value)
                                }
                                onWorkflowScopesChangeAction([...nextSelected].toSorted())
                              }}
                            >
                              <SelectionIndicator checked={checked} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {workflow.title || workflow.workflow_name}
                                </span>
                                <span className="text-muted-foreground block truncate text-xs">
                                  {workflow.workflow_name}
                                </span>
                              </span>
                            </CommandItem>
                          )
                        })}
                    </CommandGroup>
                  ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}
      {selectedWorkflowScopes.map((workflowScope) => (
        <input key={workflowScope} type="hidden" name={workflowScopesName} value={workflowScope} />
      ))}
    </div>
  )
}

function SelectionIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        checked
          ? "bg-primary text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-xs border border-transparent"
          : "border-input bg-input/30 flex size-4 shrink-0 items-center justify-center rounded-xs border"
      }
    >
      {checked ? <CheckIcon className="size-3.5" /> : null}
    </span>
  )
}
