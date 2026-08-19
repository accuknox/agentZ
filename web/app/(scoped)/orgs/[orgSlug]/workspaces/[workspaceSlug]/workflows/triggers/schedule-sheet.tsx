"use client"

import * as React from "react"
import { toast } from "sonner"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch, type Control, type Resolver } from "react-hook-form"
import { CalendarCheck, ListFilter, MinusCircle, Workflow } from "lucide-react"
import * as z from "zod"
import type {
  JsonValue,
  WorkflowArbitraryJson,
  WorkflowInputSchema,
  WorkflowSchedule,
  WorkflowSummary,
} from "@/lib/gateway/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Textarea } from "@/components/ui/textarea"
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
import { dayjs } from "@/lib/format"
import type {
  CreateWorkflowScheduleFormState,
  UpdateWorkflowScheduleFormState,
  WorkflowInputContractResult,
} from "@/data/types"
import {
  buildWorkflowScheduleFormSchema,
  type CreateWorkflowScheduleFormValues,
  type WorkflowInputContract,
  type WorkflowScheduleInputValue,
  workflowInputDefaultValues,
  workflowScheduleInputsSchema,
} from "@/data/workflow-schedule.schema"

const historyLimitDefault = 3
const timeoutSecondsDefault = 3600
const scheduleServerFieldSchema = z.enum([
  "name",
  "workflow_name",
  "schedule",
  "time_zone",
  "timeout_seconds",
  "successful_runs_history_limit",
  "failed_runs_history_limit",
  "arbitrary_json",
])
const scheduleInputServerFieldSchema = z.templateLiteral([
  "inputs.",
  z.string({ error: "Workflow input name is required" }).min(1, "Workflow input name is required"),
])

const createDefaults: CreateWorkflowScheduleFormValues = {
  name: "",
  workflow_name: "",
  schedule: "",
  time_zone: "UTC",
  timeout_seconds: timeoutSecondsDefault,
  successful_runs_history_limit: historyLimitDefault,
  failed_runs_history_limit: historyLimitDefault,
  inputs: {},
  arbitrary_json: "",
}

type ScheduleSheetActionState = CreateWorkflowScheduleFormState | UpdateWorkflowScheduleFormState

type ScheduleSheetAction = (
  agentName: string,
  state: ScheduleSheetActionState,
  formData: FormData
) => Promise<ScheduleSheetActionState>

type ScheduleFormControl = Control<
  CreateWorkflowScheduleFormValues,
  unknown,
  CreateWorkflowScheduleFormValues
>

type ScheduleSheetCreateProps = {
  agentName: string
  mode: "create"
  workflows: WorkflowSummary[]
  createWorkflowScheduleAction: ScheduleSheetAction
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}

type ScheduleSheetUpdateProps = {
  agentName: string
  mode: "update"
  workflows: WorkflowSummary[]
  scheduleItem: WorkflowSchedule
  putWorkflowScheduleAction: ScheduleSheetAction
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}

type ScheduleSheetProps = ScheduleSheetCreateProps | ScheduleSheetUpdateProps

export function ScheduleSheet(props: ScheduleSheetProps) {
  const { agentName, getWorkflowInputContractAction, mode, onOpenChangeAction, open, workflows } =
    props
  const scheduleItem = mode === "update" ? props.scheduleItem : null
  const [workflowInputContract, setWorkflowInputContract] = React.useState<WorkflowInputContract>({
    inputs: {},
  })
  const [schemaError, setSchemaError] = React.useState<string>()
  const [schemaPending, startSchemaTransition] = React.useTransition()
  const schemaRequestRef = React.useRef(0)
  const formSchema = React.useMemo(
    () => buildWorkflowScheduleFormSchema(workflowInputContract),
    [workflowInputContract]
  )
  const resolver = React.useMemo<Resolver<CreateWorkflowScheduleFormValues>>(
    () => (values, context, options) => zodResolver(formSchema)(values, context, options),
    [formSchema]
  )
  const initialValues = React.useMemo<CreateWorkflowScheduleFormValues>(() => {
    if (mode === "create") {
      const firstWorkflowName = workflows[0]?.workflow_name ?? ""
      return {
        ...createDefaults,
        workflow_name: firstWorkflowName,
        time_zone: dayjs.tz.guess() || "UTC",
      }
    }

    if (scheduleItem) {
      return scheduleValuesFromItem(scheduleItem)
    }

    return createDefaults
  }, [mode, scheduleItem, workflows])
  const form = useForm<CreateWorkflowScheduleFormValues>({
    resolver,
    mode: "onBlur",
    defaultValues: createDefaults,
    values: initialValues,
  })
  const [state, action, isPending] = React.useActionState<ScheduleSheetActionState, FormData>(
    async (state, formData) => {
      const result =
        mode === "create"
          ? await props.createWorkflowScheduleAction(agentName, state, formData)
          : await props.putWorkflowScheduleAction(agentName, state, formData)
      if (result.success) {
        toast.success(mode === "create" ? "Schedule created" : "Schedule updated")
        onOpenChangeAction(false)
      }
      return result
    },
    {}
  )
  const loadWorkflowInputContract = React.useCallback(
    async (workflowName: string, values: CreateWorkflowScheduleFormValues) => {
      const requestId = schemaRequestRef.current + 1
      schemaRequestRef.current = requestId

      if (!workflowName) {
        setWorkflowInputContract({ inputs: {} })
        setSchemaError(undefined)
        form.reset({
          ...values,
          inputs: {},
          arbitrary_json: "",
        })
        return
      }

      const result = await getWorkflowInputContractAction(agentName, workflowName)
      if (schemaRequestRef.current !== requestId) {
        return
      }

      if (!result.ok) {
        setWorkflowInputContract({ inputs: {} })
        setSchemaError(result.error.message)
        form.reset({
          ...values,
          workflow_name: workflowName,
          inputs: {},
          arbitrary_json: "",
        })
        return
      }

      const contract = {
        inputs: result.inputs,
        arbitrary_json: result.arbitrary_json,
      }
      const inputs =
        contract.arbitrary_json || mode === "create"
          ? workflowInputDefaultValues(result.inputs)
          : mergeWorkflowInputValues(result.inputs, values.inputs)
      const arbitraryJSON = contract.arbitrary_json
        ? mode === "create"
          ? workflowArbitraryJSONDefaultValue(contract.arbitrary_json)
          : values.arbitrary_json
        : ""

      setWorkflowInputContract(contract)
      setSchemaError(undefined)
      form.reset({
        ...values,
        workflow_name: workflowName,
        inputs,
        arbitrary_json: arbitraryJSON,
      })
    },
    [agentName, form, getWorkflowInputContractAction, mode]
  )

  React.useEffect(() => {
    if (!open) {
      return
    }

    startSchemaTransition(() => {
      void loadWorkflowInputContract(initialValues.workflow_name, initialValues)
    })
  }, [initialValues, loadWorkflowInputContract, open])

  React.useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const err of state.error.errors) {
      if (!err.field) {
        continue
      }

      const field =
        workflowInputContract.arbitrary_json &&
        (err.field === "inputs" || err.field.startsWith("inputs."))
          ? "arbitrary_json"
          : err.field

      const inputField = scheduleInputServerFieldSchema.safeParse(field)
      if (inputField.success) {
        form.setError(inputField.data, {
          type: "server",
          message: err.message,
        })
        continue
      }

      const scheduleField = scheduleServerFieldSchema.safeParse(field)
      if (scheduleField.success) {
        form.setError(scheduleField.data, {
          type: "server",
          message: err.message,
        })
      }
    }
  }, [form, state.error, workflowInputContract.arbitrary_json])

  const workflowName = useWatch({ control: form.control, name: "workflow_name" })
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
          error.field === "arbitrary_json" ||
          error.field === "inputs" ||
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
    if (workflowInputContract.arbitrary_json) {
      formData.set("arbitrary_json", values.arbitrary_json)
      React.startTransition(() => {
        action(formData)
      })
      return
    }

    for (const [name, value] of Object.entries(values.inputs)) {
      if (value === undefined || value === "") {
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
      setWorkflowInputContract({ inputs: {} })
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
      void loadWorkflowInputContract(nextWorkflowName, {
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
                  <FieldDescription>Use lowercase letters, numbers, and hyphens.</FieldDescription>
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
                            <Workflow />
                            {workflow.workflow_name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Choose the saved Workflow this schedule will run.
                  </FieldDescription>
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
                  <FieldDescription>Enter a 5-field cron expression.</FieldDescription>
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
                    Stop a scheduled Workflow run after this many seconds.
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
                    Successful run history limit
                  </FieldLabel>
                  <input
                    type="hidden"
                    name={field.name}
                    value={field.value.toString()}
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
                  <FieldDescription>Keep this many successful runs.</FieldDescription>
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
                    Failed run history limit
                  </FieldLabel>
                  <input
                    type="hidden"
                    name={field.name}
                    value={field.value.toString()}
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
                  <FieldDescription>Keep this many failed runs.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            {workflowName ? (
              <WorkflowInputsSection
                control={form.control}
                contract={workflowInputContract}
                pending={schemaPending}
              />
            ) : null}
          </FieldGroup>
          {generalErrorMessage ? (
            <Alert
              className="-mx-4 w-[calc(100%+2rem)] max-w-none shrink-0 px-4"
              variant="destructive"
            >
              <AlertDescription>{generalErrorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending || schemaPending} className="w-full">
              {isPending ? <Spinner /> : <CalendarCheck data-icon="inline-start" />}
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
  contract,
  pending,
}: {
  control: ScheduleFormControl
  contract: WorkflowInputContract
  pending: boolean
}) {
  if (pending) {
    return (
      <Field>
        <FieldLabel>Inputs</FieldLabel>
        <WorkflowInputsSkeleton />
      </Field>
    )
  }

  if (contract.arbitrary_json) {
    return <WorkflowArbitraryJSONField control={control} input={contract.arbitrary_json} />
  }

  const entries = Object.entries(contract.inputs)

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

function WorkflowArbitraryJSONField({
  control,
  input,
}: {
  control: ScheduleFormControl
  input: WorkflowArbitraryJson
}) {
  return (
    <Controller
      name="arbitrary_json"
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor="input-arbitrary-json">Arbitrary JSON</FieldLabel>
          <Textarea
            id="input-arbitrary-json"
            name={field.name}
            ref={field.ref}
            value={field.value}
            onBlur={field.onBlur}
            onChange={field.onChange}
            placeholder={input.description ?? "Enter JSON"}
            className="min-h-48 resize-y font-mono"
            spellCheck={false}
            aria-invalid={fieldState.invalid}
          />
          {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
        </Field>
      )}
    />
  )
}

function WorkflowInputField({
  name,
  input,
  control,
}: {
  name: string
  input: WorkflowInputSchema
  control: ScheduleFormControl
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
                  field.onChange(
                    value === "__empty__"
                      ? undefined
                      : enumValues.find((enumValue) => JSON.stringify(enumValue) === value)
                  )
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
                    {!input.required ? (
                      <SelectItem value="__empty__">
                        <MinusCircle /> Unset
                      </SelectItem>
                    ) : null}
                    {enumValues.map((value) => {
                      const serialized = JSON.stringify(value)
                      return (
                        <SelectItem key={serialized} value={serialized}>
                          <ListFilter />
                          {value.toString()}
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
                value={workflowInputFormValue(field.value)}
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

function scheduleValuesFromItem(item: WorkflowSchedule): CreateWorkflowScheduleFormValues {
  const inputs = workflowScheduleInputsSchema.catch({}).parse(item.inputs)

  return {
    name: item.name,
    workflow_name: item.workflow_name,
    schedule: item.schedule,
    time_zone: item.time_zone ?? "UTC",
    timeout_seconds: item.timeout_seconds,
    successful_runs_history_limit: item.successful_runs_history_limit,
    failed_runs_history_limit: item.failed_runs_history_limit,
    inputs,
    arbitrary_json: jsonText(item.inputs),
  }
}

function workflowInputFormValue(value: WorkflowScheduleInputValue) {
  return value === undefined ? "" : value.toString()
}

function mergeWorkflowInputValues(
  inputSchema: WorkflowInputContract["inputs"],
  currentInputs: CreateWorkflowScheduleFormValues["inputs"]
) {
  const defaults = workflowInputDefaultValues(inputSchema)
  const nextInputs: CreateWorkflowScheduleFormValues["inputs"] = {}

  for (const name of Object.keys(inputSchema)) {
    nextInputs[name] = currentInputs[name] ?? defaults[name]
  }

  return nextInputs
}

function workflowArbitraryJSONDefaultValue(input: WorkflowArbitraryJson) {
  if (!("default_payload" in input)) {
    return ""
  }

  return jsonText(input.default_payload)
}

function jsonText(value: JsonValue | undefined) {
  if (value === undefined) {
    return ""
  }

  return JSON.stringify(value, null, 2)
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
