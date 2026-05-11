"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { defineStepper } from "@stepperize/react"
import { Bot, Hammer, Layers, SlidersHorizontal } from "lucide-react"
import { motion } from "motion/react"
import Link from "next/link"
import { useActionState, useEffect, useEffectEvent, useRef, useState } from "react"
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  useForm,
  useWatch,
} from "react-hook-form"
import { WizardShell } from "@/components/blocks/wizard"
import { BotIcon, type BotIconHandle } from "@/components/ui/bot"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { createAgentFormAction, updateAgentFormAction } from "@/data/agent.actions"
import { listEnvironmentsAction } from "@/data/environment.actions"
import {
  baseModelSchema,
  compactionSchema,
  identitySchema,
  maxSystemPromptChars,
  modelSchema,
  primaryModels,
  summaryModels,
  toolsSchema,
} from "@/data/schema"
import type { AgentWizardValues, Compaction, Identity, Model, Tools } from "@/data/types"
import { defaultAgentWizardValues } from "@/data/utils"
import type { Environment } from "@/lib/gateway/client"

const blinkIntervalMs = 2500

const textareaClassName =
  "min-h-36 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"

const rangeClassName = "w-full accent-primary"

type DataStepId = "identity" | "compaction" | "model" | "tools"
type StoredStepId = Exclude<DataStepId, "tools">

type WizardData = Partial<Omit<AgentWizardValues, "tools">>

type WizardMode = "create" | "update"

type StepperWithFormProps = {
  environments: Environment[]
  initialValues?: AgentWizardValues
  initialHasNextEnvironmentPage: boolean
  initialNextEnvironmentPageToken: string
  mode?: WizardMode
  agentName?: string
}

type WizardCopy = {
  submitLabel: string
  pendingLabel: string
}

const wizardCopy: Record<WizardMode, WizardCopy> = {
  create: {
    submitLabel: "Create agent",
    pendingLabel: "Creating...",
  },
  update: {
    submitLabel: "Update agent",
    pendingLabel: "Updating...",
  },
}

type StepperMetadata = {
  identity?: Identity
  compaction?: Compaction
  model?: Model
}

const steps = [
  {
    id: "identity",
    title: "Identity",
    icon: Bot,
  },
  {
    id: "compaction",
    title: "Compaction",
    icon: Layers,
  },
  {
    id: "model",
    title: "Model",
    icon: SlidersHorizontal,
  },
  {
    id: "tools",
    title: "Tools",
    icon: Hammer,
  },
] as const

const { Stepper } = defineStepper(...steps)

function uniqueEnvironments(environments: Environment[]) {
  const seen = new Set<string>()
  return environments.filter((environment) => {
    if (seen.has(environment.name)) return false

    seen.add(environment.name)
    return true
  })
}

function agentWizardValuesWithEnvironment(
  values: AgentWizardValues,
  environments: Environment[]
): AgentWizardValues {
  const environmentName = values.identity.environmentName || environments[0]?.name || ""

  return {
    ...values,
    identity: {
      ...values.identity,
      environmentName,
    },
  }
}

function AgentWizardBotFlare() {
  const botRef = useRef<BotIconHandle>(null)
  const startBotAnimation = useEffectEvent(() => {
    botRef.current?.startAnimation()
  })

  useEffect(() => {
    startBotAnimation()

    const interval = window.setInterval(() => {
      startBotAnimation()
    }, blinkIntervalMs)

    return () => window.clearInterval(interval)
  }, [])

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute -top-7 right-6 z-10 hidden origin-center rounded-full border bg-card/95 p-2.5 text-primary shadow-lg shadow-primary/10 backdrop-blur sm:block"
      animate={{
        rotate: [30, 36, 30, 24, 30],
        scale: [1, 1.04, 1],
        y: [0, -8, 0],
      }}
      transition={{
        duration: 3.2,
        ease: "easeInOut",
        repeat: Infinity,
      }}
    >
      <BotIcon ref={botRef} size={34} />
    </motion.div>
  )
}

const canVisitStep = (index: number, currentIndex: number, data: WizardData) => {
  if (index <= currentIndex) return true

  return [data.identity, data.compaction, data.model].slice(0, index).every(Boolean)
}

function IdentityForm({
  defaultValues,
  environments,
  hasNextEnvironmentPage,
  lockName,
  nextEnvironmentPageToken,
  onNext,
}: {
  defaultValues?: Identity
  environments: Environment[]
  hasNextEnvironmentPage: boolean
  lockName?: boolean
  nextEnvironmentPageToken: string
  onNext: (data: Identity) => void
}) {
  const form = useForm<Identity>({
    resolver: zodResolver(identitySchema),
    defaultValues: defaultValues ?? defaultAgentWizardValues.identity,
  })
  const systemPrompt = useWatch({
    control: form.control,
    name: "systemPrompt",
    defaultValue: form.getValues("systemPrompt"),
  })
  const promptLen = [...systemPrompt].length
  const hasEnvironments = environments.length > 0

  return (
    <form id="agent-form-identity" onSubmit={form.handleSubmit(onNext)} className="space-y-5">
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="agent-form-name">Agent name</FieldLabel>
              <Input
                id="agent-form-name"
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={field.onChange}
                disabled={lockName}
                aria-invalid={fieldState.invalid}
                placeholder="coding-agent"
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          name="environmentName"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="agent-form-environment">Environment</FieldLabel>
              <EnvironmentSelect
                disabled={!hasEnvironments}
                id="agent-form-environment"
                name={field.name}
                value={field.value}
                initialEnvironments={environments}
                initialHasNextPage={hasNextEnvironmentPage}
                initialNextPageToken={nextEnvironmentPageToken}
                onBlurAction={field.onBlur}
                onValueChangeAction={field.onChange}
                aria-invalid={fieldState.invalid}
              />
              {!hasEnvironments ? (
                <FieldDescription>
                  Create an environment{" "}
                  <Link
                    href="/environments/new"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    here
                  </Link>{" "}
                  before continuing.
                </FieldDescription>
              ) : null}
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          name="systemPrompt"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="agent-form-system-prompt">System prompt</FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {promptLen}/{maxSystemPromptChars}
                </span>
              </div>
              <textarea
                id="agent-form-system-prompt"
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={field.onChange}
                aria-invalid={fieldState.invalid}
                className={textareaClassName}
                placeholder="Hard rules, role framing, and non-negotiable constraints."
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <StepActions>
        <Button type="submit" disabled={!hasEnvironments}>
          Next
        </Button>
      </StepActions>
    </form>
  )
}

function EnvironmentSelect({
  "aria-invalid": ariaInvalid,
  disabled,
  id,
  initialEnvironments,
  initialHasNextPage,
  initialNextPageToken,
  name,
  onBlurAction,
  onValueChangeAction,
  value,
}: {
  "aria-invalid"?: boolean
  disabled?: boolean
  id: string
  initialEnvironments: Environment[]
  initialHasNextPage: boolean
  initialNextPageToken: string
  name: string
  onBlurAction: () => void
  onValueChangeAction: (value: string) => void
  value: string
}) {
  const [environments, setEnvironments] = useState(() => uniqueEnvironments(initialEnvironments))
  const [hasNextPage, setHasNextPage] = useState(initialHasNextPage)
  const [nextPageToken, setNextPageToken] = useState(initialNextPageToken)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const loadNextPage = useEffectEvent(async () => {
    if (!hasNextPage || loading || nextPageToken === "") return

    setLoading(true)
    setError(undefined)
    const result = await listEnvironmentsAction({ limit: 50, page_token: nextPageToken })
    setLoading(false)

    if (result.error) {
      setError(result.error.message)
      return
    }

    setEnvironments((current) => uniqueEnvironments([...current, ...result.environments]))
    setHasNextPage(result.hasNextPage)
    setNextPageToken(result.nextPageToken)
  })

  const selectedIsLoaded = environments.some((environment) => environment.name === value)
  const options =
    value && !selectedIsLoaded
      ? [
          {
            name: value,
            packages: [],
            created_at: "",
            metadata: { package_count: 0 },
          },
          ...environments,
        ]
      : environments

  useEffect(() => {
    if (!sentinel || !hasNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNextPage()
        }
      },
      { rootMargin: "48px" }
    )
    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [hasNextPage, sentinel])

  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChangeAction} name={name}>
      <SelectTrigger id={id} onBlur={onBlurAction} aria-invalid={ariaInvalid} className="w-full">
        <SelectValue placeholder="Select an environment" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectGroup>
          {options.map((environment) => (
            <SelectItem key={environment.name} value={environment.name}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectGroup>
        {hasNextPage ? (
          <div
            ref={setSentinel}
            className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
          >
            {loading ? <Spinner aria-hidden="true" /> : null}
            {loading ? "Loading environments..." : "Scroll for more environments"}
          </div>
        ) : null}
        {error ? <div className="px-2 py-1.5 text-xs text-destructive">{error}</div> : null}
      </SelectContent>
    </Select>
  )
}

function CompactionForm({
  defaultValues,
  onNext,
  onPrev,
}: {
  defaultValues?: Compaction
  onNext: (data: Compaction) => void
  onPrev: () => void
}) {
  const form = useForm<Compaction>({
    resolver: zodResolver(compactionSchema),
    defaultValues: defaultValues ?? defaultAgentWizardValues.compaction,
  })
  const mode = useWatch({ control: form.control, name: "mode" })

  return (
    <form id="agent-form-compaction" onSubmit={form.handleSubmit(onNext)} className="space-y-5">
      <FieldGroup>
        <Controller
          name="mode"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="agent-form-compaction-mode">Mode</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                <SelectTrigger
                  id="agent-form-compaction-mode"
                  ref={field.ref}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="summary">Summary</SelectItem>
                  <SelectItem value="truncate">Truncate</SelectItem>
                </SelectContent>
              </Select>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <SliderField
          control={form.control}
          name="thresholdRatio"
          label="Threshold ratio"
          min={0.2}
          max={0.95}
          step={0.01}
        />
        <SliderField
          control={form.control}
          name="historyToolResultRatio"
          label="History tool result ratio"
          min={0}
          max={1}
          step={0.001}
        />
        <NumberField
          control={form.control}
          name="keepRecentRequests"
          label="Keep recent requests"
          min={0}
          step={1}
        />
        <SliderField
          control={form.control}
          name="oversizedToolResultRatio"
          label="Oversized tool result ratio"
          min={0.05}
          max={0.1}
          step={0.001}
        />
        {mode === "truncate" && (
          <NumberField
            control={form.control}
            name="maxHistoryRuns"
            label="Max history runs"
            min={0}
            step={1}
          />
        )}
      </FieldGroup>
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          Previous
        </Button>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function ModelForm({
  compactionMode,
  defaultValues,
  onNext,
  onPrev,
}: {
  compactionMode: Compaction["mode"]
  defaultValues?: Model
  onNext: (data: Model) => void
  onPrev: () => void
}) {
  const form = useForm<Model>({
    resolver: zodResolver(compactionMode === "truncate" ? baseModelSchema : modelSchema),
    defaultValues: defaultValues ?? defaultAgentWizardValues.model,
  })
  const summaryDisabled = compactionMode === "truncate"

  return (
    <form id="agent-form-model" onSubmit={form.handleSubmit(onNext)} className="space-y-5">
      <FieldGroup>
        <Controller
          name="primaryName"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="agent-form-primary-model">Primary model</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                <SelectTrigger
                  id="agent-form-primary-model"
                  ref={field.ref}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {primaryModels.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="primaryContextWindow"
          label="Primary model context window"
          min={1}
          step={1}
        />
        <SliderField
          control={form.control}
          name="primaryTemperature"
          label="Primary model temperature"
          min={0}
          max={1}
          step={0.01}
        />
        <Controller
          name="summaryName"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid} data-disabled={summaryDisabled}>
              <FieldLabel htmlFor="agent-form-summary-model">Summary model</FieldLabel>
              <Select
                value={field.value}
                disabled={summaryDisabled}
                onValueChange={field.onChange}
                name={field.name}
              >
                <SelectTrigger
                  id="agent-form-summary-model"
                  ref={field.ref}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {summaryModels.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <NumberField
          control={form.control}
          name="summaryContextWindow"
          label="Summary model context window"
          min={summaryDisabled ? 0 : 1}
          step={1}
          disabled={summaryDisabled}
        />
        <SliderField
          control={form.control}
          name="summaryTemperature"
          label="Summary model temperature"
          min={0}
          max={1}
          step={0.01}
          disabled={summaryDisabled}
        />
      </FieldGroup>
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          Previous
        </Button>
        <Button type="submit">Next</Button>
      </StepActions>
    </form>
  )
}

function ToolsForm({
  data,
  defaultValues,
  mode,
  onPrev,
  agentName,
}: {
  data: Pick<Required<WizardData>, "identity" | "compaction" | "model">
  defaultValues?: Tools
  mode: WizardMode
  onPrev: () => void
  agentName?: string
}) {
  const formAction =
    mode === "update" && agentName
      ? updateAgentFormAction.bind(null, agentName)
      : createAgentFormAction
  const [state, action, isPending] = useActionState(formAction, {})
  const form = useForm<Tools>({
    resolver: zodResolver(toolsSchema),
    defaultValues: defaultValues ?? defaultAgentWizardValues.tools,
  })
  const copy = wizardCopy[mode]

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    await action(formData)
  }

  return (
    <form id="agent-form-tools" action={submitAction} className="space-y-5">
      <HiddenAgentFields data={data} />
      <FieldGroup>
        <CheckboxField
          control={form.control}
          name="hostExec"
          label="Host exec"
          description="Allow local shell command execution tools."
        />
        <CheckboxField
          control={form.control}
          name="webFetch"
          label="Web fetch"
          description="Allow HTTP fetch tooling."
        />
        <CheckboxField
          control={form.control}
          name="file"
          label="File"
          description="Allow local filesystem tools."
        />
        <CheckboxField
          control={form.control}
          name="arxiv"
          label="arXiv"
          description="Allow arXiv search tooling."
        />
      </FieldGroup>
      {state.error && (
        <div role="alert" className="rounded border border-destructive/40 p-3 text-sm">
          <p className="font-medium text-destructive">{state.error.message}</p>
          {state.error.errors?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-destructive">
              {state.error.errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  {error.field}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev} disabled={isPending}>
          Previous
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? <Spinner aria-hidden="true" /> : null}
          {isPending ? copy.pendingLabel : copy.submitLabel}
        </Button>
      </StepActions>
    </form>
  )
}

function NumberField<TForm extends FieldValues>({
  control,
  disabled,
  label,
  max,
  min,
  name,
  step,
}: {
  control: Control<TForm>
  disabled?: boolean
  label: string
  max?: number
  min?: number
  name: Path<TForm>
  step: number
}) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} data-disabled={disabled}>
          <FieldLabel htmlFor={`agent-form-${String(name)}`}>{label}</FieldLabel>
          <Input
            id={`agent-form-${String(name)}`}
            type="number"
            name={field.name}
            ref={field.ref}
            value={Number.isNaN(field.value) ? "" : field.value}
            onBlur={field.onBlur}
            onChange={(event) => {
              field.onChange(event.target.value === "" ? Number.NaN : event.target.valueAsNumber)
            }}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-invalid={fieldState.invalid}
          />
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )
}

function SliderField<TForm extends FieldValues>({
  control,
  disabled,
  label,
  max,
  min,
  name,
  step,
}: {
  control: Control<TForm>
  disabled?: boolean
  label: string
  max: number
  min: number
  name: Path<TForm>
  step: number
}) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} data-disabled={disabled}>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor={`agent-form-${String(name)}`}>{label}</FieldLabel>
            <span className="text-xs text-muted-foreground">{field.value}</span>
          </div>
          <input
            id={`agent-form-${String(name)}`}
            type="range"
            name={field.name}
            ref={field.ref}
            value={field.value}
            onBlur={field.onBlur}
            onChange={(event) => field.onChange(event.target.valueAsNumber)}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-invalid={fieldState.invalid}
            className={rangeClassName}
          />
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )
}

function CheckboxField({
  control,
  description,
  label,
  name,
}: {
  control: Control<Tools>
  description: string
  label: string
  name: keyof Tools
}) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <Field orientation="horizontal">
          <input
            id={`agent-form-${String(name)}`}
            type="checkbox"
            name={field.name}
            ref={field.ref}
            checked={field.value}
            onBlur={field.onBlur}
            onChange={(event) => field.onChange(event.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          <FieldContent>
            <FieldLabel htmlFor={`agent-form-${String(name)}`}>
              <FieldTitle>{label}</FieldTitle>
            </FieldLabel>
            <FieldDescription>{description}</FieldDescription>
          </FieldContent>
        </Field>
      )}
    />
  )
}

function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-3">{children}</div>
}

function HiddenAgentFields({
  data,
}: {
  data: Pick<Required<WizardData>, "identity" | "compaction" | "model">
}) {
  return (
    <>
      <input type="hidden" name="name" value={data.identity.name} />
      <input type="hidden" name="environmentName" value={data.identity.environmentName} />
      <input type="hidden" name="systemPrompt" value={data.identity.systemPrompt} />
      <input type="hidden" name="compactionMode" value={data.compaction.mode} />
      <input type="hidden" name="thresholdRatio" value={String(data.compaction.thresholdRatio)} />
      <input
        type="hidden"
        name="historyToolResultRatio"
        value={String(data.compaction.historyToolResultRatio)}
      />
      <input
        type="hidden"
        name="keepRecentRequests"
        value={String(data.compaction.keepRecentRequests)}
      />
      <input
        type="hidden"
        name="oversizedToolResultRatio"
        value={String(data.compaction.oversizedToolResultRatio)}
      />
      <input type="hidden" name="maxHistoryRuns" value={String(data.compaction.maxHistoryRuns)} />
      <input type="hidden" name="primaryName" value={data.model.primaryName} />
      <input
        type="hidden"
        name="primaryContextWindow"
        value={String(data.model.primaryContextWindow)}
      />
      <input
        type="hidden"
        name="primaryTemperature"
        value={String(data.model.primaryTemperature)}
      />
      <input type="hidden" name="summaryName" value={data.model.summaryName} />
      <input
        type="hidden"
        name="summaryContextWindow"
        value={String(data.model.summaryContextWindow)}
      />
      <input
        type="hidden"
        name="summaryTemperature"
        value={String(data.model.summaryTemperature)}
      />
    </>
  )
}

export function StepperWithForm({
  environments,
  initialValues = defaultAgentWizardValues,
  initialHasNextEnvironmentPage,
  initialNextEnvironmentPageToken,
  mode = "create",
  agentName,
}: StepperWithFormProps) {
  const [direction, setDirection] = useState(1)
  const initialWizardValues = agentWizardValuesWithEnvironment(initialValues, environments)

  return (
    <Stepper.Root
      className="flex min-h-0 w-full flex-1"
      initialMetadata={{
        identity: initialWizardValues.identity,
        compaction: initialWizardValues.compaction,
        model: initialWizardValues.model,
      }}
      orientation="vertical"
    >
      {({ stepper }) => {
        const stored = <TStep extends StoredStepId>(id: TStep) =>
          stepper.metadata.get(id) as StepperMetadata[TStep] | undefined
        const formData: StepperMetadata = {
          identity: stored("identity") as Identity | undefined,
          compaction: stored("compaction") as Compaction | undefined,
          model: stored("model") as Model | undefined,
        }
        const goNext = () => {
          setDirection(1)
          stepper.navigation.next()
        }
        const goPrev = () => {
          setDirection(-1)
          stepper.navigation.prev()
        }
        const setStepData = <TStep extends StoredStepId>(
          id: TStep,
          value: NonNullable<WizardData[TStep]>
        ) => {
          stepper.metadata.set(id, value)
        }
        const createReadyData =
          formData.identity && formData.compaction && formData.model
            ? {
                identity: formData.identity,
                compaction: formData.compaction,
                model: formData.model,
              }
            : undefined

        return (
          <WizardShell
            steps={steps}
            currentIndex={stepper.state.current.index}
            currentStepId={stepper.state.current.data.id}
            direction={direction}
            panelAdornment={<AgentWizardBotFlare />}
            canVisitStepAction={(_, index) =>
              canVisitStep(index, stepper.state.current.index, formData)
            }
            onStepSelectAction={(step, index) => {
              setDirection(index >= stepper.state.current.index ? 1 : -1)
              stepper.navigation.goTo(step.id)
            }}
          >
            {stepper.flow.switch({
              identity: () => (
                <IdentityForm
                  defaultValues={formData.identity}
                  environments={environments}
                  hasNextEnvironmentPage={initialHasNextEnvironmentPage}
                  lockName={mode === "update"}
                  nextEnvironmentPageToken={initialNextEnvironmentPageToken}
                  onNext={(data) => {
                    setStepData("identity", data)
                    goNext()
                  }}
                />
              ),
              compaction: () => (
                <CompactionForm
                  defaultValues={formData.compaction}
                  onNext={(data) => {
                    setStepData("compaction", data)
                    goNext()
                  }}
                  onPrev={goPrev}
                />
              ),
              model: () => (
                <ModelForm
                  compactionMode={
                    formData.compaction?.mode ?? defaultAgentWizardValues.compaction.mode
                  }
                  defaultValues={formData.model}
                  onNext={(data) => {
                    setStepData("model", data)
                    goNext()
                  }}
                  onPrev={goPrev}
                />
              ),
              tools: () =>
                createReadyData ? (
                  <ToolsForm
                    data={createReadyData}
                    defaultValues={initialWizardValues.tools}
                    mode={mode}
                    onPrev={goPrev}
                    agentName={agentName}
                  />
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Complete the previous steps before creating an agent.
                    </p>
                    <Button type="button" variant="secondary" onClick={goPrev}>
                      Previous
                    </Button>
                  </div>
                ),
            })}
          </WizardShell>
        )
      }}
    </Stepper.Root>
  )
}
