"use client"

import { useId, useLayoutEffect, useRef, useState } from "react"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Scale,
  CalendarClock,
  CircleAlert,
  Plus,
  Play,
  RefreshCw,
  Square,
  Timer,
  Layers,
} from "lucide-react"
import {
  createWorkflowEvaluation,
  updateWorkflowEvaluation,
  type EvaluationModel,
  type JsonValue,
  type Workflow,
  type WorkflowEvaluation,
  type WorkflowEvaluationSummary,
  type FieldError as APIFieldError,
} from "@/lib/gateway/client"
import {
  listAgentModelCatalogOptions,
  listWorkflowEvaluationsOptions,
  getWorkflowEvaluationOptions,
} from "@/lib/gateway/client/@tanstack/react-query.gen"
import { zWorkflowEvaluationRequest } from "@/lib/gateway/client/zod.gen"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import {
  buildWorkflowInputObjectSchema,
  workflowInputDefaultValues,
  workflowScheduleArbitraryJSONSchema,
} from "@/data/workflow-schedule.schema"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel, FieldError, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dayjs } from "@/lib/format"

import { ProviderIcons } from "@/app/(app)/inference/providers/provider-shared"
import { Results, ResultsSkeleton } from "./results"

export function EvaluationsSkeleton() {
  return (
    <>
      <div
        aria-hidden
        className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-1 sm:px-6 motion-reduce:[&_[data-slot=skeleton]]:animate-none"
      >
        <Skeleton className="h-11 w-full sm:h-8 sm:w-[28rem]" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="ml-auto h-8 w-32" />
      </div>
      <ResultsSkeleton />
    </>
  )
}

export function Evaluations({
  workflow,
  workspaceId,
}: {
  workflow: Workflow
  workspaceId: string
}) {
  const queryClient = useQueryClient()
  const pickerLabelId = useId()
  const [selected, setSelected] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [hint, setHint] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const headers = { "X-AgentZ-Workspace-ID": workspaceId }
  const branding = useQuery({
    ...listAgentModelCatalogOptions({ headers, path: { agentName: workflow.agent_name } }),
    staleTime: 60_000,
  })
  const providerBrands = Object.fromEntries(
    (branding.data ?? []).map((item) => [
      JSON.stringify([item.provider_id, item.model_id]),
      item.providers,
    ])
  )
  const path = { agentName: workflow.agent_name, workflowName: workflow.workflow_name }
  const historyOptions = listWorkflowEvaluationsOptions({ headers, path })
  const history = useQuery({
    ...historyOptions,
    refetchInterval: (query) =>
      query.state.data?.some((item) => ["queued", "running", "cancelling"].includes(item.state))
        ? 5000
        : false,
  })
  const id = selected ?? history.data?.[0]?.id
  const selectedEvaluation = history.data?.find((item) => item.id === id)
  const detailOptions = getWorkflowEvaluationOptions({
    headers,
    path: { ...path, evaluationId: id ?? "" },
  })
  const detail = useQuery({
    ...detailOptions,
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data && ["queued", "running", "cancelling"].includes(query.state.data.state)
        ? 2000
        : false,
  })
  const evaluation = detail.data
  const active = evaluation && ["queued", "running", "cancelling"].includes(evaluation.state)
  const catalog = useQuery(
    queryOptions({
      queryKey: ["evaluation-models", workspaceId, workflow.agent_name],
      enabled: creating || retrying,
      staleTime: 60_000,
      queryFn: async () => {
        const client = await createAgentOpencodeClient(workflow.agent_name, workspaceId)
        const { data } = await client.config.providers({}, { throwOnError: true })
        return data.providers.flatMap((provider) =>
          Object.values(provider.models)
            .filter((model) => model.capabilities.toolcall)
            .flatMap((model) => {
              const base: EvaluationModel = {
                provider_id: provider.id,
                model_id: model.id,
                label: model.name,
              }
              return [
                base,
                ...Object.keys(model.variants ?? {}).map((variant) => ({
                  ...base,
                  variant,
                  label: `${model.name} · ${variant}`,
                })),
              ].map((model) => ({
                model,
                group: provider.name,
                key: JSON.stringify([model.provider_id, model.model_id, model.variant]),
              }))
            })
        )
      },
    })
  )

  async function refresh(result: WorkflowEvaluation) {
    setSelected(result.id)
    queryClient.setQueryData(
      getWorkflowEvaluationOptions({ headers, path: { ...path, evaluationId: result.id } })
        .queryKey,
      result
    )
    await queryClient.invalidateQueries({ queryKey: historyOptions.queryKey })
  }

  async function cancel() {
    if (!id) return
    setActionPending(true)
    setActionError(undefined)
    try {
      const { data, error } = await updateWorkflowEvaluation({
        headers,
        path: { ...path, evaluationId: id },
        body: { action: "cancel" },
      })
      if (error) {
        setActionError(error.message)
        return
      }
      await refresh(data)
    } catch {
      setActionError("Could not cancel. Try again.")
    } finally {
      setActionPending(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-1 sm:px-6">
        {history.data?.length ? (
          <Select
            value={id}
            onValueChange={setSelected}
            open={pickerOpen}
            onOpenChange={(open) => {
              setPickerOpen(open)
              setHint(undefined)
            }}
          >
            <SelectTrigger
              aria-labelledby={pickerLabelId}
              className="w-full min-w-0 rounded-md data-[size=default]:h-11 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 sm:w-[28rem] sm:data-[size=default]:h-8"
            >
              <SelectValue id={pickerLabelId} placeholder="Evaluation">
                <span className="sr-only">Evaluation: </span>
                {selectedEvaluation ? <EvaluationLabel evaluation={selectedEvaluation} /> : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              collisionPadding={16}
              className="w-[min(40rem,calc(100vw-2rem))] max-w-(--radix-select-content-available-width)"
            >
              <SelectGroup>
                {history.data.map((item) => {
                  const label = `${dayjs(item.created_at).format("MMM D, h:mm A")} · ${
                    item.executions.map(({ model }) => model.label || model.model_id).join(", ") ||
                    "No models"
                  }`
                  return (
                    <Tooltip
                      key={item.id}
                      delayDuration={500}
                      open={hint === item.id}
                      onOpenChange={(open) => setHint(open ? item.id : undefined)}
                    >
                      <SelectItem
                        value={item.id}
                        textValue={label}
                        className="min-h-11 py-2 *:last:min-w-0 *:last:flex-1 sm:min-h-8 sm:py-1.5"
                        onFocus={(event) => {
                          if (event.currentTarget.matches(":focus-visible")) setHint(item.id)
                        }}
                        onBlur={() => setHint(undefined)}
                      >
                        <TooltipTrigger asChild>
                          <span className="flex min-w-0 flex-1">
                            <EvaluationLabel evaluation={item} />
                          </span>
                        </TooltipTrigger>
                      </SelectItem>
                      <TooltipContent
                        className="max-w-[min(32rem,calc(100vw-2rem))] wrap-anywhere whitespace-normal"
                        onEscapeKeyDown={() => setPickerOpen(false)}
                      >
                        {label}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium">Evaluations</span>
        )}
        {evaluation ? (
          <Badge
            className="capitalize"
            variant={
              evaluation.state === "completed"
                ? "success"
                : evaluation.state === "running"
                  ? "running"
                  : evaluation.state === "cancelling"
                    ? "warning"
                    : "pending"
            }
          >
            {evaluation.state}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={actionPending || evaluation.state === "cancelling"}
              onClick={cancel}
            >
              <Square />
              Cancel
            </Button>
          ) : evaluation?.state === "completed" ? (
            <Button size="sm" variant="outline" onClick={() => setRetrying(true)}>
              <RefreshCw />
              Judge again
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New evaluation
          </Button>
        </div>
      </div>
      {history.error || detail.error || actionError ? (
        <Alert variant="destructive" className="m-4 w-auto">
          <CircleAlert />
          <AlertDescription>{actionError ?? "Could not load evaluations."}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void history.refetch()
              void detail.refetch()
              setActionError(undefined)
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      {history.isPending || (id && detail.isPending) ? (
        <ResultsSkeleton rows={selectedEvaluation?.executions.length} />
      ) : evaluation ? (
        <Results
          key={evaluation.id}
          evaluation={evaluation}
          workspaceId={workspaceId}
          providerBrands={providerBrands}
        />
      ) : !history.error && !detail.error ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          No evaluations yet
        </div>
      ) : null}
      <Sheet
        open={creating || retrying}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false)
            setRetrying(false)
          }
        }}
      >
        <SheetContent className="flex w-full flex-col data-[side=right]:sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{retrying ? "Judge again" : "New evaluation"}</SheetTitle>
            <SheetDescription>{workflow.title}</SheetDescription>
          </SheetHeader>
          {catalog.isPending ? (
            <div
              role="status"
              aria-label="Loading models"
              className="flex min-h-0 flex-1 flex-col motion-reduce:[&_[data-slot=skeleton]]:animate-none"
            >
              <div aria-hidden className="flex-1 overflow-y-auto px-4 pb-4">
                <FieldGroup>
                  {!retrying ? (
                    <Field>
                      <FieldLabel>Models</FieldLabel>
                      <Skeleton className="h-8 w-full" />
                    </Field>
                  ) : null}
                  <Field>
                    <FieldLabel>
                      <Scale className="text-muted-foreground size-4" />
                      Judge
                    </FieldLabel>
                    <Skeleton className="h-8 w-full" />
                    <FieldDescription>Use your strongest model.</FieldDescription>
                  </Field>
                  {!retrying ? (
                    <>
                      <Field>
                        <FieldLabel>Parallel runs</FieldLabel>
                        <Skeleton className="h-3 w-full" />
                      </Field>
                      <Field>
                        <FieldLabel>Run timeout (seconds)</FieldLabel>
                        <Skeleton className="h-8 w-full" />
                      </Field>
                    </>
                  ) : null}
                  {!retrying && workflow.arbitrary_json ? (
                    <Field>
                      <FieldLabel>Inputs</FieldLabel>
                      <Skeleton className="h-36 w-full" />
                    </Field>
                  ) : null}
                  {!retrying && !workflow.arbitrary_json
                    ? Object.entries(workflow.inputs ?? {}).map(([name, input]) => (
                        <Field key={name}>
                          <FieldLabel required={input.required}>{name}</FieldLabel>
                          <Skeleton className="h-8 w-full" />
                          {input.description ? (
                            <FieldDescription>{input.description}</FieldDescription>
                          ) : null}
                        </Field>
                      ))
                    : null}
                </FieldGroup>
              </div>
              <SheetFooter aria-hidden className="border-t">
                <Skeleton className="h-3 w-64" />
                <Skeleton className="h-8 w-full" />
              </SheetFooter>
            </div>
          ) : catalog.error ? (
            <Alert variant="destructive" className="mx-4 w-auto">
              <CircleAlert />
              <AlertDescription>Could not load models.</AlertDescription>
              <Button variant="outline" onClick={() => void catalog.refetch()}>
                Retry
              </Button>
            </Alert>
          ) : !catalog.data?.length ? (
            <p className="text-muted-foreground p-4 text-sm">No models available for this agent.</p>
          ) : (
            <EvaluationForm
              key={retrying ? `judge-${id}` : "new"}
              workflow={workflow}
              models={catalog.data}
              providerBrands={providerBrands}
              workspaceId={workspaceId}
              retry={retrying ? evaluation : undefined}
              onComplete={async (result) => {
                setCreating(false)
                setRetrying(false)
                await refresh(result)
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

function EvaluationLabel({ evaluation }: { evaluation: WorkflowEvaluationSummary }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [count, setCount] = useState(1)
  const date = dayjs(evaluation.created_at).format("MMM D, h:mm A")
  const names = evaluation.executions.map(({ model }) => model.label || model.model_id)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const candidates = Array.from(node.querySelectorAll<HTMLSpanElement>("[data-fit]"))
    const observer = new ResizeObserver(() => {
      const width = node.getBoundingClientRect().width
      const last = candidates.findLastIndex(
        (candidate) => candidate.getBoundingClientRect().width <= width
      )
      setCount(Math.max(1, last + 1))
    })
    // Observe the text too so fitting stays correct after fonts load.
    observer.observe(node)
    candidates.forEach((candidate) => observer.observe(candidate))
    return () => observer.disconnect()
  }, [evaluation.executions])

  const remaining = Math.max(0, names.length - count)
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className="sr-only">
        {date} · {names.join(", ") || "No models"}
      </span>
      <CalendarClock aria-hidden className="text-muted-foreground" />
      <span aria-hidden className="text-muted-foreground shrink-0">
        {date}
      </span>
      <span aria-hidden className="text-muted-foreground shrink-0">
        ·
      </span>
      <span ref={ref} aria-hidden className="relative flex min-w-0 flex-1 overflow-hidden">
        <span className="truncate">{names.slice(0, count).join(", ") || "No models"}</span>
        {remaining > 0 ? (
          <span className="text-muted-foreground shrink-0">, … +{remaining}</span>
        ) : null}
        <span className="pointer-events-none invisible absolute top-0 left-0 flex flex-col items-start">
          {names.map((_, index) => (
            <span key={index} data-fit className="w-max">
              {names.slice(0, index + 1).join(", ")}
              {index < names.length - 1 ? `, … +${names.length - index - 1}` : ""}
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}

function EvaluationForm({
  workflow,
  models,
  workspaceId,
  providerBrands,
  retry,
  onComplete,
}: {
  workflow: Workflow
  models: { model: EvaluationModel; key: string; group: string }[]
  workspaceId: string
  providerBrands: Record<string, string[]>
  retry?: WorkflowEvaluation
  onComplete: (result: WorkflowEvaluation) => Promise<void>
}) {
  const [selection, setSelection] = useState<string[]>([])
  const [concurrency, setConcurrency] = useState(1)
  const timeout = useRef<HTMLInputElement>(null)
  const [judgeKey, setJudgeKey] = useState(
    () =>
      models.find(
        (item) =>
          retry &&
          item.model.provider_id === retry.request.judge.provider_id &&
          item.model.model_id === retry.request.judge.model_id &&
          item.model.variant === retry.request.judge.variant
      )?.key ?? ""
  )
  const [inputs, setInputs] = useState(() => workflowInputDefaultValues(workflow.inputs ?? {}))
  const [json, setJSON] = useState("{}")
  const [errors, setErrors] = useState<APIFieldError[]>([])
  const [failure, setFailure] = useState<string>()
  const [pending, setPending] = useState(false)
  const request = useRef<{ id: string; body: string }>(undefined)
  const busy = useRef(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current) return
    const form = event.currentTarget
    const issues: APIFieldError[] = []
    const timeoutSeconds = zWorkflowEvaluationRequest.shape.timeout_seconds
      .unwrap()
      .safeParse(timeout.current?.valueAsNumber)
    if (!retry && !timeoutSeconds.success)
      issues.push({ field: "timeout_seconds", message: "Enter 1–604800 whole seconds" })
    const judge = models.find((item) => item.key === judgeKey)?.model
    const chosen = models.filter((item) => selection.includes(item.key)).map((item) => item.model)
    if (!judge) issues.push({ field: "judge", message: "Select a judge" })
    if (!retry && (!chosen.length || chosen.length > 8))
      issues.push({ field: "models", message: "Select 1–8 models" })
    const parsed = workflow.arbitrary_json
      ? workflowScheduleArbitraryJSONSchema.safeParse(json)
      : buildWorkflowInputObjectSchema(workflow.inputs ?? {})
          .transform((values) => {
            const defined: Record<string, JsonValue> = {}
            for (const [name, value] of Object.entries(values)) {
              if (value !== undefined) defined[name] = value
            }
            return defined
          })
          .safeParse(inputs)
    if (!retry && !parsed.success)
      for (const issue of parsed.error.issues)
        issues.push({
          field: `inputs${issue.path.length ? `.${issue.path.join(".")}` : ""}`,
          message: issue.message,
        })
    setErrors(issues)
    setFailure(undefined)
    if (issues.length || !judge || (!retry && !parsed.success)) {
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    busy.current = true
    setPending(true)
    try {
      const headers = { "X-AgentZ-Workspace-ID": workspaceId }
      const path = { agentName: workflow.agent_name, workflowName: workflow.workflow_name }
      if (retry) {
        const { data, error } = await updateWorkflowEvaluation({
          headers,
          path: { ...path, evaluationId: retry.id },
          body: { action: "judge", judge },
        })
        if (error) {
          setFailure(error.message)
          return
        }
        await onComplete(data)
        return
      }
      if (!parsed.success || !timeoutSeconds.success) return
      const body = {
        inputs: parsed.data ?? null,
        models: chosen,
        judge,
        timeout_seconds: timeoutSeconds.data,
        concurrency,
      }
      const identity = JSON.stringify(body)
      if (request.current?.body !== identity) {
        request.current = { id: crypto.randomUUID(), body: identity }
      }
      const { data, error } = await createWorkflowEvaluation({
        headers,
        path,
        body: { ...body, id: request.current.id },
      })
      if (error) {
        setErrors(error.errors ?? [])
        if (!error.errors?.length) setFailure(error.message)
        requestAnimationFrame(() =>
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
        )
        return
      }
      await onComplete(data)
    } catch {
      setFailure("Could not start evaluation. Your settings are saved here. Try again.")
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <FieldGroup>
          {!retry ? (
            <Field data-invalid={errors.some((error) => error.field === "models")}>
              <FieldLabel htmlFor="evaluation-models">Models</FieldLabel>
              <MultiSelectDropdown
                id="evaluation-models"
                options={models.map((item) => ({
                  value: item.key,
                  label: item.model.label,
                  group: item.group,
                  iconElement: (
                    <ProviderIcons
                      className="size-4 shrink-0"
                      providers={
                        providerBrands[
                          JSON.stringify([item.model.provider_id, item.model.model_id])
                        ] ?? []
                      }
                    />
                  ),
                  disabled: selection.length >= 8 && !selection.includes(item.key),
                }))}
                value={selection}
                onValueChangeAction={(value) => {
                  setSelection(value)
                  setErrors((errors) => errors.filter((error) => error.field !== "models"))
                }}
                invalid={errors.some((error) => error.field === "models")}
                placeholder="Select models"
              />
              <FieldError errors={errors.filter((error) => error.field === "models")} />
            </Field>
          ) : null}
          <Field data-invalid={errors.some((error) => error.field === "judge")}>
            <FieldLabel htmlFor="evaluation-judge">
              <Scale className="text-muted-foreground size-4" />
              Judge
            </FieldLabel>
            <Select
              value={judgeKey}
              onValueChange={(value) => {
                setJudgeKey(value)
                setErrors((errors) => errors.filter((error) => error.field !== "judge"))
              }}
            >
              <SelectTrigger
                id="evaluation-judge"
                className="w-full"
                aria-invalid={errors.some((error) => error.field === "judge")}
              >
                <SelectValue placeholder="Select a judge" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {models.map((item) => (
                    <SelectItem value={item.key} key={item.key}>
                      <ProviderIcons
                        className="size-4 shrink-0"
                        providers={
                          providerBrands[
                            JSON.stringify([item.model.provider_id, item.model.model_id])
                          ] ?? []
                        }
                      />
                      {item.model.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>Use your strongest model.</FieldDescription>
            <FieldError errors={errors.filter((error) => error.field === "judge")} />
          </Field>
          {!retry ? (
            <>
              <Field data-invalid={errors.some((error) => error.field === "concurrency")}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel id="evaluation-concurrency-label" htmlFor="evaluation-concurrency">
                    <Layers className="text-muted-foreground size-4" />
                    Parallel runs
                  </FieldLabel>
                  <output className="text-muted-foreground text-sm tabular-nums">
                    {concurrency}
                  </output>
                </div>
                <Slider
                  id="evaluation-concurrency"
                  aria-labelledby="evaluation-concurrency-label"
                  min={1}
                  max={5}
                  step={1}
                  value={[concurrency]}
                  onValueChange={([value]) => {
                    setConcurrency(value ?? 1)
                    setErrors((errors) => errors.filter((error) => error.field !== "concurrency"))
                  }}
                  aria-invalid={errors.some((error) => error.field === "concurrency")}
                />
                <FieldError errors={errors.filter((error) => error.field === "concurrency")} />
              </Field>
              <Field data-invalid={errors.some((error) => error.field === "timeout_seconds")}>
                <FieldLabel htmlFor="evaluation-timeout">
                  <Timer className="text-muted-foreground size-4" />
                  Run timeout (seconds)
                </FieldLabel>
                <Input
                  ref={timeout}
                  id="evaluation-timeout"
                  type="number"
                  defaultValue={900}
                  min={1}
                  max={604800}
                  step={1}
                  required
                  onChange={() =>
                    setErrors((errors) =>
                      errors.filter((error) => error.field !== "timeout_seconds")
                    )
                  }
                  aria-invalid={errors.some((error) => error.field === "timeout_seconds")}
                />
                <FieldError errors={errors.filter((error) => error.field === "timeout_seconds")} />
              </Field>
            </>
          ) : null}
          {!retry && workflow.arbitrary_json ? (
            <Field data-invalid={errors.some((error) => error.field === "inputs")}>
              <FieldLabel htmlFor="evaluation-inputs">Inputs</FieldLabel>
              <Textarea
                id="evaluation-inputs"
                value={json}
                onChange={(event) => {
                  setJSON(event.target.value)
                  setErrors((errors) => errors.filter((error) => error.field !== "inputs"))
                }}
                rows={6}
                aria-invalid={errors.some((error) => error.field === "inputs")}
              />
              <FieldError errors={errors.filter((error) => error.field === "inputs")} />
            </Field>
          ) : null}
          {!retry && !workflow.arbitrary_json
            ? Object.entries(workflow.inputs ?? {}).map(([name, input]) => {
                const fieldErrors = errors.filter((error) => error.field === `inputs.${name}`)
                const options = input.enum ?? (input.type === "boolean" ? [true, false] : undefined)
                return (
                  <Field key={name} data-invalid={!!fieldErrors.length}>
                    <FieldLabel htmlFor={`evaluation-${name}`} required={input.required}>
                      {name}
                    </FieldLabel>
                    {options ? (
                      <Select
                        value={
                          inputs[name] === undefined ? "__unset__" : JSON.stringify(inputs[name])
                        }
                        onValueChange={(value) => {
                          setErrors((current) =>
                            current.filter((error) => error.field !== `inputs.${name}`)
                          )
                          setInputs((previous) => ({
                            ...previous,
                            [name]: options.find((option) => JSON.stringify(option) === value),
                          }))
                        }}
                      >
                        <SelectTrigger
                          id={`evaluation-${name}`}
                          className="w-full"
                          aria-invalid={!!fieldErrors.length}
                        >
                          <SelectValue placeholder="Select a value" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="__unset__">
                              {input.required ? "Select a value" : "Unset"}
                            </SelectItem>
                            {options.map((option) => (
                              <SelectItem
                                key={JSON.stringify(option)}
                                value={JSON.stringify(option)}
                              >
                                {option.toString()}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={`evaluation-${name}`}
                        type={
                          input.type === "integer" || input.type === "number" ? "number" : "text"
                        }
                        step={input.type === "integer" ? 1 : "any"}
                        value={inputs[name]?.toString() ?? ""}
                        aria-invalid={!!fieldErrors.length}
                        onChange={(event) => {
                          const value = event.target.value
                          setErrors((errors) =>
                            errors.filter((error) => error.field !== `inputs.${name}`)
                          )
                          setInputs((previous) => ({
                            ...previous,
                            [name]:
                              value === ""
                                ? undefined
                                : input.type === "integer" || input.type === "number"
                                  ? event.target.valueAsNumber
                                  : value,
                          }))
                        }}
                      />
                    )}
                    <FieldError errors={fieldErrors} />
                    {input.description ? (
                      <FieldDescription>{input.description}</FieldDescription>
                    ) : null}
                  </Field>
                )
              })
            : null}
          {failure ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </div>
      <SheetFooter className="border-t">
        <p className="text-muted-foreground text-xs">
          {retry
            ? "Uses saved transcripts. Workflows will not run again."
            : "Runs can change shared files and services."}
        </p>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : <Play />}
          {retry ? "Judge executions" : "Run evaluation"}
        </Button>
      </SheetFooter>
    </form>
  )
}
