"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, type Control, type Resolver } from "react-hook-form"
import type {
  WorkflowInputSchema,
  WorkflowInputs,
  WorkflowSchedule,
  WorkflowSummary,
} from "@/lib/gateway/client"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  RequiredIndicator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import type {
  CreateWorkflowScheduleFormState,
  UpdateWorkflowScheduleFormState,
  WorkflowInputSchemaResult,
} from "@/data/types"
import {
  buildWorkflowScheduleFormSchema,
  workflowInputDefaultValues,
} from "@/data/workflow-schedule.schema"

const historyLimitDefault = 3
const timeoutSecondsDefault = 3600
type ScheduleFormValues = {
  name: string
  workflow_name: string
  schedule: string
  time_zone: string
  timeout_seconds: number
  successful_runs_history_limit: number
  failed_runs_history_limit: number
  inputs: Record<string, unknown>
}

const createDefaults: ScheduleFormValues = {
  name: "",
  workflow_name: "",
  schedule: "",
  time_zone: "UTC",
  timeout_seconds: timeoutSecondsDefault,
  successful_runs_history_limit: historyLimitDefault,
  failed_runs_history_limit: historyLimitDefault,
  inputs: {},
}

type ScheduleSheetActionState = CreateWorkflowScheduleFormState | UpdateWorkflowScheduleFormState

type ScheduleSheetAction = (
  agentName: string,
  state: ScheduleSheetActionState,
  formData: FormData
) => Promise<ScheduleSheetActionState>

type ScheduleSheetCreateProps = {
  agentName: string
  mode: "create"
  workflows: WorkflowSummary[]
  createWorkflowScheduleAction: ScheduleSheetAction
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}

type ScheduleSheetUpdateProps = {
  agentName: string
  mode: "update"
  workflows: WorkflowSummary[]
  scheduleItem: WorkflowSchedule
  putWorkflowScheduleAction: ScheduleSheetAction
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}

type ScheduleSheetProps = ScheduleSheetCreateProps | ScheduleSheetUpdateProps

export function ScheduleSheet(props: ScheduleSheetProps) {
  const { agentName, getWorkflowInputSchemaAction, mode, onOpenChangeAction, open, workflows } =
    props
  const scheduleItem = mode === "update" ? props.scheduleItem : null
  const [workflowInputs, setWorkflowInputs] = React.useState<WorkflowInputs>({})
  const [schemaError, setSchemaError] = React.useState<string>()
  const [schemaPending, startSchemaTransition] = React.useTransition()
  const schemaRequestRef = React.useRef(0)
  const formSchema = React.useMemo(
    () => buildWorkflowScheduleFormSchema(workflowInputs),
    [workflowInputs]
  )
  const resolver = React.useMemo<Resolver<ScheduleFormValues>>(
    () => (values, context, options) => zodResolver(formSchema)(values, context, options),
    [formSchema]
  )
  const form = useForm<ScheduleFormValues>({
    resolver,
    mode: "onBlur",
    defaultValues: createDefaults,
  })
  const formAction =
    mode === "create"
      ? props.createWorkflowScheduleAction.bind(null, agentName)
      : props.putWorkflowScheduleAction.bind(null, agentName)
  const [state, action, isPending] = React.useActionState<ScheduleSheetActionState, FormData>(
    formAction,
    {}
  )
  const loadWorkflowInputs = React.useCallback(
    async (workflowName: string, values: ScheduleFormValues) => {
      const requestId = schemaRequestRef.current + 1
      schemaRequestRef.current = requestId

      if (!workflowName) {
        setWorkflowInputs({})
        setSchemaError(undefined)
        form.reset({
          ...values,
          inputs: {},
        })
        return
      }

      const result = await getWorkflowInputSchemaAction(agentName, workflowName)
      if (schemaRequestRef.current !== requestId) {
        return
      }

      if (!result.ok) {
        setWorkflowInputs({})
        setSchemaError(result.error.message)
        form.reset({
          ...values,
          workflow_name: workflowName,
          inputs: {},
        })
        return
      }

      const inputs =
        mode === "create"
          ? workflowInputDefaultValues(result.inputs)
          : mergeWorkflowInputValues(result.inputs, values.inputs)

      setWorkflowInputs(result.inputs)
      setSchemaError(undefined)
      form.reset({
        ...values,
        workflow_name: workflowName,
        inputs,
      })
      void form.trigger()
    },
    [agentName, form, getWorkflowInputSchemaAction, mode]
  )

  React.useEffect(() => {
    if (isPending || state.error) {
      return
    }

    setSchemaError(undefined)
    setWorkflowInputs({})
    onOpenChangeAction(false)
  }, [form, isPending, onOpenChangeAction, state.error])

  React.useEffect(() => {
    if (!open) {
      return
    }

    let nextValues: ScheduleFormValues
    if (mode === "create") {
      const firstWorkflowName = workflows[0]?.workflow_name ?? ""
      nextValues = {
        ...createDefaults,
        workflow_name: firstWorkflowName,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }
    } else {
      if (!scheduleItem) {
        return
      }

      nextValues = scheduleValuesFromItem(scheduleItem)
    }

    form.reset(nextValues)
    setWorkflowInputs({})
    setSchemaError(undefined)

    startSchemaTransition(() => {
      void loadWorkflowInputs(nextValues.workflow_name, nextValues)
    })
  }, [form, loadWorkflowInputs, mode, open, scheduleItem, workflows])

  React.useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const err of state.error.errors) {
      if (!err.field) {
        continue
      }

      if (err.field.startsWith("inputs.")) {
        form.setError(err.field as `inputs.${string}`, {
          type: "server",
          message: err.message,
        })
        continue
      }

      if (err.field in createDefaults) {
        form.setError(err.field as keyof ScheduleFormValues, {
          type: "server",
          message: err.message,
        })
      }
    }
  }, [form, state.error])

  // eslint-disable-next-line react-hooks/incompatible-library -- React Hook Form watch is required for dynamic workflow input rendering.
  const workflowName = form.watch("workflow_name")
  const generalErrorMessage = React.useMemo(() => {
    if (schemaError) {
      return schemaError
    }
    if (!state.error) {
      return undefined
    }

    const fieldErrors =
      state.error.errors?.filter((error) => {
        if (!error.field) {
          return false
        }

        return (
          error.field === "name" ||
          error.field === "workflow_name" ||
          error.field === "schedule" ||
          error.field === "time_zone" ||
          error.field === "timeout_seconds" ||
          error.field === "successful_runs_history_limit" ||
          error.field === "failed_runs_history_limit" ||
          error.field.startsWith("inputs.")
        )
      }) ?? []
    const hasGeneralError = !state.error.errors || state.error.errors.length > fieldErrors.length

    return hasGeneralError ? state.error.message : undefined
  }, [schemaError, state.error])

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    const values = form.getValues()
    for (const [name, value] of Object.entries(values.inputs)) {
      if (
        value === undefined ||
        value === "" ||
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      ) {
        continue
      }
      formData.set(`input:${name}`, JSON.stringify(value))
    }

    React.startTransition(() => {
      action(formData)
    })
  }

  function onSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      schemaRequestRef.current += 1
      setSchemaError(undefined)
      setWorkflowInputs({})
    }
    onOpenChangeAction(nextOpen)
  }

  function onWorkflowChange(nextWorkflowName: string) {
    form.clearErrors("workflow_name")
    form.setValue("workflow_name", nextWorkflowName, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    })

    startSchemaTransition(() => {
      const currentValues = form.getValues()
      void loadWorkflowInputs(nextWorkflowName, {
        ...currentValues,
        workflow_name: nextWorkflowName,
      })
    })
  }

  const isUpdate = mode === "update"
  const title = isUpdate ? "Edit schedule" : "New schedule"
  const description = scheduleItem
    ? `Update the "${scheduleItem.name}" schedule. The schedule name cannot be changed.`
    : "Create a workflow schedule for this agent."
  const submitLabel = isUpdate ? "Save changes" : "Create schedule"
  const pendingLabel = isUpdate ? "Saving..." : "Creating..."

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      <SheetContent className="h-full overflow-y-auto px-4 pt-3 pb-4 sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0 gap-0 px-0 py-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <form action={submitAction} className="flex flex-1 flex-col gap-4 px-0 pt-1 pb-0">
          <FieldGroup>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="schedule-name" required>
                    Name
                  </FieldLabel>
                  <Input
                    id="schedule-name"
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="nightly-triage"
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                    disabled={isUpdate}
                    readOnly={isUpdate}
                  />
                  <input type="hidden" name={field.name} value={field.value} ref={field.ref} />
                  <FieldDescription>
                    Allowed: Lowercase alphabets, numbers and hyphens.
                  </FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <Controller
              name="workflow_name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="schedule-workflow" required>
                    Workflow name
                  </FieldLabel>
                  <input type="hidden" name={field.name} value={field.value} ref={field.ref} />
                  <Select
                    value={field.value}
                    onValueChange={onWorkflowChange}
                    disabled={isPending || schemaPending || workflows.length === 0}
                  >
                    <SelectTrigger
                      id="schedule-workflow"
                      className="w-full"
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                    >
                      <SelectValue placeholder="Select a workflow" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {workflows.map((workflow) => (
                          <SelectItem key={workflow.workflow_name} value={workflow.workflow_name}>
                            {workflow.workflow_name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Saved workflow to run on this schedule.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <Controller
              name="schedule"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="schedule-cron" required>
                    Schedule
                  </FieldLabel>
                  <Input
                    id="schedule-cron"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="0 3 * * 1"
                    className="font-mono"
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                  />
                  <FieldDescription>Cron expression.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <input type="hidden" {...form.register("time_zone")} />
            <Controller
              name="timeout_seconds"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="schedule-timeout" required>
                    Timeout seconds
                  </FieldLabel>
                  <Input
                    id="schedule-timeout"
                    name={field.name}
                    ref={field.ref}
                    type="number"
                    min={1}
                    max={604800}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value)
                      field.onChange(Number.isNaN(nextValue) ? event.target.value : nextValue)
                    }}
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                  />
                  <FieldDescription>
                    Maximum runtime for one scheduled workflow run.
                  </FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <Controller
              name="successful_runs_history_limit"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="successful-runs-history-limit" required>
                    Successful Runs History Limit
                  </FieldLabel>
                  <input
                    type="hidden"
                    name={field.name}
                    value={String(field.value)}
                    ref={field.ref}
                  />
                  <div className="flex flex-col gap-3">
                    <div className="text-muted-foreground text-sm">{field.value}</div>
                    <Slider
                      id="successful-runs-history-limit"
                      min={1}
                      max={10}
                      step={1}
                      value={[field.value]}
                      onValueChange={(value) => field.onChange(value[0] ?? historyLimitDefault)}
                      onBlur={field.onBlur}
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                    />
                  </div>
                  <FieldDescription>Number of successful runs to retain.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <Controller
              name="failed_runs_history_limit"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="failed-runs-history-limit" required>
                    Failed Runs History Limit
                  </FieldLabel>
                  <input
                    type="hidden"
                    name={field.name}
                    value={String(field.value)}
                    ref={field.ref}
                  />
                  <div className="flex flex-col gap-3">
                    <div className="text-muted-foreground text-sm">{field.value}</div>
                    <Slider
                      id="failed-runs-history-limit"
                      min={1}
                      max={10}
                      step={1}
                      value={[field.value]}
                      onValueChange={(value) => field.onChange(value[0] ?? historyLimitDefault)}
                      onBlur={field.onBlur}
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                    />
                  </div>
                  <FieldDescription>Number of failed runs to retain.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            {workflowName ? (
              <WorkflowInputsSection
                control={form.control}
                inputs={workflowInputs}
                pending={schemaPending}
              />
            ) : null}
          </FieldGroup>
          {generalErrorMessage ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive shrink-0 rounded-md border p-3 text-sm">
              {generalErrorMessage}
            </p>
          ) : null}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending || schemaPending} className="w-full">
              {isPending ? <Spinner /> : null}
              {isPending ? pendingLabel : submitLabel}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function WorkflowInputsSection({
  control,
  inputs,
  pending,
}: {
  control: Control<ScheduleFormValues, unknown, ScheduleFormValues>
  inputs: WorkflowInputs
  pending: boolean
}) {
  const entries = Object.entries(inputs)

  if (pending) {
    return (
      <Field>
        <FieldLabel>Inputs</FieldLabel>
        <WorkflowInputsSkeleton />
      </Field>
    )
  }

  if (entries.length === 0) {
    return (
      <Field>
        <FieldLabel>Inputs</FieldLabel>
        <div className="text-muted-foreground text-sm">No runtime inputs</div>
      </Field>
    )
  }

  return (
    <Field>
      <FieldLabel>Inputs</FieldLabel>
      <FieldGroup>
        {entries.map(([name, input]) => (
          <WorkflowInputField key={name} name={name} input={input} control={control} />
        ))}
      </FieldGroup>
    </Field>
  )
}

function WorkflowInputField({
  name,
  input,
  control,
}: {
  name: string
  input: WorkflowInputSchema
  control: Control<ScheduleFormValues, unknown, ScheduleFormValues>
}) {
  const enumValues = input.enum

  if (enumValues && enumValues.length > 0) {
    return (
      <Controller
        name={`inputs.${name}` as const}
        control={control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <input
              type="hidden"
              name={field.name}
              value={field.value === undefined ? "" : JSON.stringify(field.value)}
              ref={field.ref}
            />
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <div className="text-foreground flex items-center gap-1 font-mono text-sm">
                  <span>{name}</span>
                  {input.required ? <RequiredIndicator className="text-xs" /> : null}
                </div>
                {input.description ? (
                  <div className="text-muted-foreground text-sm">{input.description}</div>
                ) : null}
              </div>
              <Select
                value={field.value === undefined ? "__empty__" : JSON.stringify(field.value)}
                onValueChange={(value) => {
                  field.onChange(value === "__empty__" ? undefined : JSON.parse(value))
                }}
              >
                <SelectTrigger
                  id={`input-${name}`}
                  className="w-full border-0 shadow-none focus-visible:ring-0"
                  aria-invalid={fieldState.invalid}
                  aria-required={input.required}
                >
                  <SelectValue placeholder={input.required ? "Select a value" : "Optional"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {!input.required ? <SelectItem value="__empty__">Unset</SelectItem> : null}
                    {enumValues.map((value) => {
                      const serialized = JSON.stringify(value)
                      return (
                        <SelectItem key={serialized} value={serialized}>
                          {String(value)}
                        </SelectItem>
                      )
                    })}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
          </Field>
        )}
      />
    )
  }

  if (input.type === "boolean") {
    return (
      <Controller
        name={`inputs.${name}` as const}
        control={control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <input
              type="hidden"
              name={field.name}
              value={field.value === undefined ? "" : JSON.stringify(field.value)}
              ref={field.ref}
            />
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <div className="text-foreground flex items-center gap-1 font-mono text-sm">
                  <span>{name}</span>
                  {input.required ? <RequiredIndicator className="text-xs" /> : null}
                </div>
                {input.description ? (
                  <div className="text-muted-foreground text-sm">{input.description}</div>
                ) : null}
              </div>
              <InputGroup className="h-9">
                <div className="flex items-center gap-3 px-2.5">
                  <Checkbox
                    id={`input-${name}`}
                    checked={Boolean(field.value)}
                    onCheckedChange={(checked) => field.onChange(Boolean(checked))}
                    aria-invalid={fieldState.invalid}
                    aria-required={input.required}
                  />
                  <span className="text-muted-foreground text-sm">
                    {input.required ? "Required" : "Optional"}
                  </span>
                </div>
              </InputGroup>
            </div>
            {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
          </Field>
        )}
      />
    )
  }

  const inputType = resolveInputType(input)
  const step = input.type === "integer" ? 1 : "any"

  return (
    <Controller
      name={`inputs.${name}` as const}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <div className="text-foreground flex items-center gap-1 font-mono text-sm">
                <span>{name}</span>
                {input.required ? <RequiredIndicator className="text-xs" /> : null}
              </div>
              {input.description ? (
                <div className="text-muted-foreground text-sm">{input.description}</div>
              ) : null}
            </div>
            <InputGroup>
              <InputGroupInput
                id={`input-${name}`}
                name={field.name}
                ref={field.ref}
                type={inputType}
                step={inputType === "number" ? step : undefined}
                min={input.minimum ?? input.exclusiveMinimum}
                max={input.maximum ?? input.exclusiveMaximum}
                value={field.value === undefined ? "" : String(field.value)}
                onBlur={field.onBlur}
                onChange={(event) => {
                  if (input.type === "integer" || input.type === "number") {
                    const nextValue = event.target.value
                    field.onChange(nextValue === "" ? undefined : Number(nextValue))
                    return
                  }

                  field.onChange(event.target.value)
                }}
                className="font-mono"
                aria-invalid={fieldState.invalid}
                aria-required={input.required}
              />
            </InputGroup>
          </div>
          {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
        </Field>
      )}
    />
  )
}

function scheduleValuesFromItem(item: WorkflowSchedule): ScheduleFormValues {
  const inputs: Record<string, unknown> = {}

  if (item.inputs && typeof item.inputs === "object" && !Array.isArray(item.inputs)) {
    for (const [name, value] of Object.entries(item.inputs)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        inputs[name] = value
      }
    }
  }

  return {
    name: item.name,
    workflow_name: item.workflow_name,
    schedule: item.schedule,
    time_zone: item.time_zone ?? "UTC",
    timeout_seconds: item.timeout_seconds,
    successful_runs_history_limit: item.successful_runs_history_limit,
    failed_runs_history_limit: item.failed_runs_history_limit,
    inputs,
  }
}

function mergeWorkflowInputValues(
  inputSchema: WorkflowInputs,
  currentInputs: Record<string, unknown>
) {
  const defaults = workflowInputDefaultValues(inputSchema)
  const nextInputs: Record<string, unknown> = {}

  for (const name of Object.keys(inputSchema)) {
    nextInputs[name] = currentInputs[name] ?? defaults[name]
  }

  return nextInputs
}

function resolveInputType(input: WorkflowInputSchema) {
  if (input.type === "integer" || input.type === "number") {
    return "number"
  }

  if (input.format === "date") {
    return "date"
  }

  if (input.format === "date-time") {
    return "datetime-local"
  }

  if (input.format === "email") {
    return "email"
  }

  if (input.format === "uri") {
    return "url"
  }

  return "text"
}

function WorkflowInputsSkeleton() {
  return (
    <FieldGroup>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-18 w-full rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-18 w-full rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-18 w-full rounded-lg" />
      </div>
    </FieldGroup>
  )
}
