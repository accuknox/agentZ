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

type WorkflowGroup = {
  agentName: string
  workflows: WorkflowSummary[]
}

type WorkflowTarget = {
  agentName: string
  workflowName: string
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
  createAPIKeyAction,
  openInitially = false,
  showTrigger = true,
  workflowsByAgent,
  workspaceName,
}: {
  agents: Agent[]
  createAPIKeyAction: (
    state: CreateAPIKeyFormState,
    formData: FormData
  ) => Promise<CreateAPIKeyFormState>
  openInitially?: boolean
  showTrigger?: boolean
  workflowsByAgent: WorkflowGroup[]
  workspaceName?: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(openInitially)
  const [dialogKey, setDialogKey] = React.useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setDialogKey((value) => value + 1)
          if (openInitially) router.replace("/settings/api-keys")
        }
      }}
    >
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button>
            <KeyRound data-icon="inline-start" />
            New API key
          </Button>
        </DialogTrigger>
      ) : null}
      <CreateAPIKeyDialog
        key={dialogKey}
        agents={agents}
        workflowsByAgent={workflowsByAgent}
        createAPIKeyAction={createAPIKeyAction}
        workspaceName={workspaceName}
      />
    </Dialog>
  )
}

function CreateAPIKeyDialog({
  agents,
  workflowsByAgent,
  createAPIKeyAction,
  workspaceName,
}: {
  agents: Agent[]
  workflowsByAgent: WorkflowGroup[]
  createAPIKeyAction: (
    state: CreateAPIKeyFormState,
    formData: FormData
  ) => Promise<CreateAPIKeyFormState>
  workspaceName?: string
}) {
  const router = useRouter()
  const [state, action, pending] = React.useActionState(createAPIKeyAction, {})
  const [workflowTargets, setWorkflowTargets] = React.useState<WorkflowTarget[]>([])
  const form = useForm<CreateAPIKeyFormValues>({
    resolver: zodResolver(createAPIKeyFormSchema),
    defaultValues: {
      type: "agent",
      name: "",
      expiresInDays: "none",
      agentNames: [],
      workflowAgentNames: [],
      workflowNames: [],
    },
  })
  const apiKeyType = useWatch({ control: form.control, name: "type" })

  React.useEffect(() => {
    if (!state.key) {
      return
    }
    React.startTransition(() => router.refresh())
  }, [router, state.key])

  const submit = form.handleSubmit((_, event) => {
    if (!event) {
      return
    }
    React.startTransition(() => action(new FormData(event.target as HTMLFormElement)))
  })

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{state.key ? "Copy your API key" : "Create API key"}</DialogTitle>
        <DialogDescription>
          {state.key
            ? "This secret is shown once. Store it now."
            : apiKeyType === "webhook"
              ? `Authorize selected workflow webhook calls${workspaceName ? ` in ${workspaceName}` : ""}.`
              : `Authorize OpenCode access to selected Agents${workspaceName ? ` in ${workspaceName}` : ""}.`}
        </DialogDescription>
      </DialogHeader>
      {state.key ? (
        <>
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
          <form id="api-key-form" onSubmit={submit} className="space-y-5">
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
                        field.onChange(value)
                        form.setValue("agentNames", [])
                        form.setValue("workflowAgentNames", [])
                        form.setValue("workflowNames", [])
                        setWorkflowTargets([])
                      }}
                      name={field.name}
                    >
                      <SelectTrigger
                        id="api-key-type"
                        onBlur={field.onBlur}
                        aria-invalid={fieldState.invalid}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="agent">
                            <BotIcon className="inline-block" />
                            Agent
                          </SelectItem>
                          <SelectItem value="webhook">
                            <Webhook className="inline-block" />
                            Webhook
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
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
                      {...field}
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                      maxLength={32}
                      placeholder="CI"
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
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
                        <SelectValue />
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
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
              {apiKeyType === "agent" ? (
                <Controller
                  name="agentNames"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="api-key-target-agents" required>
                        Accessible Agents
                      </FieldLabel>
                      <MultiSelectDropdown
                        id="api-key-target-agents"
                        invalid={fieldState.invalid}
                        onBlurAction={field.onBlur}
                        onValueChangeAction={field.onChange}
                        options={
                          agents.map((agent) => ({
                            label: agent.name,
                            value: agent.name,
                          })) satisfies MultiSelectDropdownOption[]
                        }
                        placeholder="Select Agents"
                        searchPlaceholder="Search Agents..."
                        value={field.value}
                      />
                      {field.value.map((agentName) => (
                        <input key={agentName} type="hidden" name="agentNames" value={agentName} />
                      ))}
                      {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                    </Field>
                  )}
                />
              ) : (
                <Field data-invalid={!!form.formState.errors.workflowNames}>
                  <FieldLabel htmlFor="api-key-target-workflows" required>
                    Accessible Workflows
                  </FieldLabel>
                  <WorkflowTargetInput
                    invalid={!!form.formState.errors.workflowNames}
                    onTargetsChangeAction={(targets) => {
                      setWorkflowTargets(targets)
                      form.setValue(
                        "workflowAgentNames",
                        targets.map(({ agentName }) => agentName),
                        { shouldDirty: true, shouldValidate: true }
                      )
                      form.setValue(
                        "workflowNames",
                        targets.map(({ workflowName }) => workflowName),
                        { shouldDirty: true, shouldValidate: true }
                      )
                    }}
                    targets={workflowTargets}
                    workflowsByAgent={workflowsByAgent}
                  />
                  {workflowTargets.map((target) => (
                    <React.Fragment key={`${target.agentName}/${target.workflowName}`}>
                      <input type="hidden" name="workflowAgentNames" value={target.agentName} />
                      <input type="hidden" name="workflowNames" value={target.workflowName} />
                    </React.Fragment>
                  ))}
                  {form.formState.errors.workflowNames ? (
                    <FieldError errors={[form.formState.errors.workflowNames]} />
                  ) : null}
                </Field>
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

function WorkflowTargetInput({
  invalid,
  onTargetsChangeAction,
  targets,
  workflowsByAgent,
}: {
  invalid: boolean
  onTargetsChangeAction: (targets: WorkflowTarget[]) => void
  targets: WorkflowTarget[]
  workflowsByAgent: WorkflowGroup[]
}) {
  const triggerLabel =
    targets.length === 0
      ? "Select workflows"
      : targets.length <= 2
        ? targets.map(({ agentName, workflowName }) => `${agentName}/${workflowName}`).join(", ")
        : `${targets.length} workflows selected`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          id="api-key-target-workflows"
          type="button"
          className={cn(
            "border-input focus-visible:border-ring focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3",
            targets.length === 0 && "text-muted-foreground",
            invalid &&
              "border-destructive ring-destructive/20 dark:border-destructive/50 focus-visible:ring-destructive/20"
          )}
        >
          <span className="line-clamp-1 text-left">{triggerLabel}</span>
          <span className="text-muted-foreground text-xs">{targets.length || ""}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
        sideOffset={8}
      >
        <Command>
          <CommandInput
            placeholder="Search workflows..."
            aria-invalid={invalid}
            aria-required="true"
          />
          <CommandList className="max-h-80">
            <CommandEmpty>No accessible workflows found.</CommandEmpty>
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
                      const checked = targets.some(
                        (target) =>
                          target.agentName === group.agentName &&
                          target.workflowName === workflow.workflow_name
                      )
                      return (
                        <CommandItem
                          key={`${group.agentName}/${workflow.workflow_name}`}
                          value={`${group.agentName} ${workflow.title} ${workflow.workflow_name}`}
                          className="cursor-pointer items-start rounded-md"
                          onMouseDown={(event) => event.preventDefault()}
                          onSelect={() => {
                            if (checked) {
                              onTargetsChangeAction(
                                targets.filter(
                                  (target) =>
                                    target.agentName !== group.agentName ||
                                    target.workflowName !== workflow.workflow_name
                                )
                              )
                              return
                            }
                            onTargetsChangeAction(
                              [
                                ...targets,
                                {
                                  agentName: group.agentName,
                                  workflowName: workflow.workflow_name,
                                },
                              ].toSorted(
                                (left, right) =>
                                  left.agentName.localeCompare(right.agentName) ||
                                  left.workflowName.localeCompare(right.workflowName)
                              )
                            )
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
