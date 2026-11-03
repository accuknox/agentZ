"use client"

import { LoadingButton } from "@/components/interior/loading-button"
import { useTransition, useEffect, useEffectEvent, useState, useId, useRef } from "react"
import { Controller, useForm, useWatch, type Control } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Box, Plus, Save, Wrench, CircleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
// The closed dialog keeps the editor unmounted; only its code loads here.
// A lazy fallback would resize the dialog when the editor becomes ready.
import AgentInstructions from "./agent-instructions"
import { AlertDescription, Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { AgentPresence } from "@/components/interior/agent-presence"
import {
  defaultAgentAppearance,
  mascotNames,
  mascotColorNames,
  mascots,
  mascotColors,
} from "@/data/mascots"
import { cn } from "@/lib/utils"
import mascotStyles from "@/components/interior/agent-presence.module.css"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  createAgentFormAction,
  updateAgentFormAction,
  type AgentActionScope,
} from "@/data/agent.actions"
import { listSandboxesAction } from "@/data/sandbox.actions"
import { createAgentSimpleFormSchema, type AgentFormValues } from "@/data/schema"
import type { CreateAgentFormState } from "@/data/types"
import type {
  Agent,
  AgentOpencodeConfig,
  ResourceScope,
  Sandbox,
  Skill,
} from "@/lib/gateway/client"
import { toast } from "sonner"

type Mode = "create" | "update"

type AgentDialogProps = {
  mode: Mode
  actionScope: AgentActionScope
  sandboxes: Sandbox[]
  immutableSkills: Skill[]
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  agentName?: string
  initialAutoArchiveHours?: number
  initialAppearance?: Agent["appearance"]
  initialSandboxName?: string
  initialPulseIntervalSeconds?: Agent["pulse_interval_seconds"]
  initialMemoryEnabled?: boolean
  initialSkills?: Agent["skills"]
  initialInstruction?: AgentOpencodeConfig["instruction"]
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

function AgentAppearanceFields({
  control,
  disabled,
}: {
  control: Control<AgentFormValues>
  disabled: boolean
}) {
  const id = useId()

  return (
    <Controller
      name="appearance"
      control={control}
      render={({ field, fieldState }) => {
        const value = field.value
        const character = mascots[value.breed]
        return (
          <Field data-invalid={fieldState.invalid}>
            <div className="flex items-center gap-3 pb-2">
              <AgentPresence mascot={value.breed} color={value.color} state="working" size={48} />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">
                  {character.name} · {mascotColors[value.color].name}
                </p>
                <p className="text-xs text-muted-foreground">{character.description}</p>
              </div>
            </div>
            <FieldGroup className="gap-5">
              <FieldSet>
                <FieldLegend id={`${id}-mascot`} variant="label">
                  Mascot
                </FieldLegend>
                <RadioGroup
                  aria-labelledby={`${id}-mascot`}
                  value={value.breed}
                  disabled={disabled}
                  className="grid-cols-3 gap-2"
                >
                  {mascotNames.map((name) => (
                    <FieldLabel
                      key={name}
                      htmlFor={`${id}-${name}`}
                      className="w-full cursor-pointer flex-col gap-1 rounded-lg border border-border px-1 py-2 text-muted-foreground transition-colors hover:bg-muted/50 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-muted/50 has-[[data-state=checked]]:text-foreground"
                    >
                      <RadioGroupItem
                        id={`${id}-${name}`}
                        value={name}
                        className="sr-only absolute"
                        onClick={() => {
                          if (name !== value.breed) field.onChange({ ...value, breed: name })
                        }}
                      />
                      <AgentPresence
                        mascot={name}
                        color={value.color}
                        state={value.breed === name ? "working" : "idle"}
                        size={28}
                      />
                      {mascots[name].name}
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>
              <FieldSet>
                <FieldLegend id={`${id}-color`} variant="label">
                  Color
                </FieldLegend>
                <RadioGroup
                  aria-labelledby={`${id}-color`}
                  value={value.color}
                  disabled={disabled}
                  className="grid-cols-5 justify-items-center gap-2"
                >
                  {mascotColorNames.map((color) => (
                    <FieldLabel
                      key={color}
                      htmlFor={`${id}-${color}`}
                      title={mascotColors[color].name}
                      className="cursor-pointer rounded-full p-1 ring-offset-background transition-shadow hover:ring-2 hover:ring-border has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[[data-state=checked]]:ring-2 has-[[data-state=checked]]:ring-foreground"
                    >
                      <RadioGroupItem
                        id={`${id}-${color}`}
                        value={color}
                        className="sr-only absolute"
                        onClick={() => {
                          if (color !== value.color) field.onChange({ ...value, color })
                        }}
                      />
                      <span
                        className={cn(
                          "size-5 rounded-full border border-foreground/10",
                          mascotStyles.swatch
                        )}
                        style={mascotColors[color].style}
                      />
                      <span className="sr-only">{mascotColors[color].name}</span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>
            </FieldGroup>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )
      }}
    />
  )
}

function SandboxSelect({
  "aria-invalid": ariaInvalid,
  disabled,
  id,
  initialSandboxes,
  initialHasNextPage,
  initialNextPageToken,
  name,
  onBlurAction,
  onValueChangeAction,
  value,
  workspaceId,
}: {
  "aria-invalid"?: boolean
  disabled?: boolean
  id: string
  initialSandboxes: Sandbox[]
  initialHasNextPage: boolean
  initialNextPageToken: string
  name: string
  onBlurAction: () => void
  onValueChangeAction: (value: string) => void
  value: string
  workspaceId?: string
}) {
  const [sandboxes, setSandboxes] = useState(() => {
    return Array.from(new Map(initialSandboxes.map((sandbox) => [sandbox.name, sandbox])).values())
  })
  const [hasNextPage, setHasNextPage] = useState(initialHasNextPage)
  const [nextPageToken, setNextPageToken] = useState(initialNextPageToken)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const loadNextPage = useEffectEvent(async () => {
    if (!hasNextPage || loading || nextPageToken === "") return

    setLoading(true)
    setError(undefined)
    const result = await listSandboxesAction(
      {
        limit: 50,
        page_token: nextPageToken,
      },
      workspaceId
    )
    setLoading(false)

    if (result.error) {
      setError(result.error.message)
      return
    }

    setSandboxes((current) => {
      return Array.from(
        new Map(
          [...current, ...result.sandboxes].map((sandbox) => [sandbox.name, sandbox])
        ).values()
      )
    })
    setHasNextPage(result.hasNextPage)
    setNextPageToken(result.nextPageToken)
  })

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
        <SelectValue placeholder="Select a sandbox" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectGroup>
          {value && !sandboxes.some((sandbox) => sandbox.name === value) ? (
            <SelectItem value={value}>
              <Box />
              {value}
            </SelectItem>
          ) : null}
          {sandboxes.map((sandbox) => (
            <SelectItem key={sandbox.name} value={sandbox.name}>
              <Box />
              {sandbox.name}
            </SelectItem>
          ))}
        </SelectGroup>
        {hasNextPage ? (
          <div
            ref={setSentinel}
            className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
          >
            {loading ? <Spinner aria-hidden="true" /> : null}
            {loading ? "Loading sandboxes..." : "Scroll for more sandboxes"}
          </div>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="px-2 py-1.5">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </SelectContent>
    </Select>
  )
}

export function AgentDialog(props: AgentDialogProps) {
  const [dialog, setDialog] = useState({ open: false, id: 0 })
  const onOpenChange = (open: boolean) => {
    setDialog(({ id }) => ({ open, id: id + 1 }))
    props.onOpenChangeAction?.(open)
  }

  return (
    <Dialog open={props.open ?? dialog.open} onOpenChange={onOpenChange}>
      {props.trigger ? (
        <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      ) : props.mode === "create" ? (
        <DialogTrigger asChild>
          <Button>
            <Plus />
            New agent
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <AgentForm key={dialog.id} {...props} onCloseAction={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AgentForm({
  actionScope,
  mode,
  sandboxes,
  immutableSkills,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  agentName,
  initialAutoArchiveHours = 0,
  initialAppearance = defaultAgentAppearance,
  initialSandboxName,
  initialMemoryEnabled = false,
  initialPulseIntervalSeconds = 1800,
  initialSkills = [],
  initialInstruction = "",
  onCloseAction,
}: Omit<AgentDialogProps, "open" | "onOpenChangeAction" | "trigger"> & {
  onCloseAction: () => void
}) {
  const router = useRouter()
  const active = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const hasSandboxes = sandboxes.length > 0
  const defaultValues: AgentFormValues = {
    name: agentName ?? "",
    appearance: initialAppearance,
    autoArchiveHours: initialAutoArchiveHours,
    sandboxScope: "Organisation",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    skills: initialSkills,
    memoryEnabled: actionScope.workspaceType !== "coding" && initialMemoryEnabled,
    instruction: initialInstruction,
    pulseIntervalSeconds: initialPulseIntervalSeconds,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSimpleFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    defaultValues,
  })
  const [isPending, startTransition] = useTransition()
  const skills = new Map(
    [...immutableSkills, ...initialSkills].map(({ scope, name }) => [
      JSON.stringify([scope, name]),
      { scope, name },
    ])
  )
  const selectedSandboxName = useWatch({
    control: form.control,
    name: "sandboxName",
    defaultValue: defaultValues.sandboxName,
  })
  const selectedSandbox = sandboxes.find((sandbox) => sandbox.name === selectedSandboxName)
  const sandboxScope: ResourceScope = selectedSandbox?.scope ?? defaultValues.sandboxScope

  const submit = (values: AgentFormValues) => {
    const input = { ...values, sandboxScope }
    startTransition(async () => {
      let result: CreateAgentFormState
      try {
        result =
          mode === "update" && agentName
            ? await updateAgentFormAction(actionScope, agentName, input)
            : await createAgentFormAction(actionScope, input)
      } catch {
        result = {
          error: { code: "network_error", message: "Could not save the agent. Try again." },
        }
      }
      // A save can finish after dismissal and must not close a newly opened form.
      if (!active.current) return
      if (result.error) {
        const messages = new Map<keyof AgentFormValues | "root", string[]>()
        const errors = result.error.errors?.length
          ? result.error.errors
          : [{ field: "", message: result.error.message }]
        for (const error of errors) {
          let field: keyof AgentFormValues | "root"
          switch (error.field.split(/[.[]/, 1)[0]) {
            case "name":
              field = mode === "create" ? "name" : "root"
              break
            case "auto_archive_hours":
              field = "autoArchiveHours"
              break
            case "appearance":
              field = "appearance"
              break
            case "skills":
              field = "skills"
              break
            case "sandbox":
            case "sandboxScope":
            case "sandboxName":
              field = "sandboxName"
              break
            case "pulse_interval_seconds":
            case "pulseIntervalSeconds":
              field = "pulseIntervalSeconds"
              break
            case "memory":
            case "memoryEnabled":
              field = "memoryEnabled"
              break
            case "opencode":
            case "instruction":
              field = "instruction"
              break
            default:
              field = "root"
          }
          const message =
            field === "root" && error.field ? `${error.field}: ${error.message}` : error.message
          messages.set(field, [...(messages.get(field) ?? []), message])
        }
        for (const [field, errors] of messages) {
          form.setError(field, { type: "server", types: { server: errors } })
        }
      }
      if (result.success) {
        toast.success(mode === "update" ? "Agent updated" : "Agent created")
        onCloseAction()
        router.refresh()
      }
    })
  }

  return (
    <>
      <DialogHeader className="shrink-0 px-5 py-4">
        <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
      </DialogHeader>
      <form
        id="agent-form-simple"
        onSubmit={(event) => void form.handleSubmit(submit)(event)}
        className="relative grid min-h-0 overflow-y-auto overscroll-contain md:grid-cols-[minmax(0,1fr)_18rem]"
        noValidate
      >
        <FieldGroup className="min-w-0 gap-4 px-5 pb-4">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            {mode === "create" ? (
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="agent-form-name" required>
                      Agent name
                    </FieldLabel>
                    <Input
                      id="agent-form-name"
                      name={field.name}
                      ref={field.ref}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={field.onChange}
                      aria-invalid={fieldState.invalid}
                      aria-required="true"
                      placeholder="coding-agent"
                      aria-describedby="agent-form-name-error"
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} id="agent-form-name-error" />
                    )}
                  </Field>
                )}
              />
            ) : (
              <Field>
                <FieldLabel htmlFor="agent-form-name-readonly">Agent name</FieldLabel>
                <Input id="agent-form-name-readonly" value={agentName ?? ""} disabled />
              </Field>
            )}
            <Controller
              name="sandboxName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="agent-form-sandbox" required>
                    Sandbox
                  </FieldLabel>
                  <SandboxSelect
                    disabled={!hasSandboxes}
                    id="agent-form-sandbox"
                    name={field.name}
                    value={field.value}
                    initialSandboxes={sandboxes}
                    initialHasNextPage={initialHasNextSandboxPage}
                    initialNextPageToken={initialNextSandboxPageToken}
                    workspaceId={actionScope.workspaceId}
                    onBlurAction={field.onBlur}
                    onValueChangeAction={field.onChange}
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                  />
                  {!hasSandboxes ? (
                    <FieldDescription>
                      Create a sandbox{" "}
                      <button
                        type="button"
                        className="text-foreground underline"
                        onClick={() => {
                          onCloseAction()
                          router.push(`${actionScope.workspacePath}/sandboxes/new`)
                        }}
                      >
                        here
                      </button>{" "}
                      before continuing.
                    </FieldDescription>
                  ) : null}
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
          <Controller
            name="skills"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="agent-form-skills">Immutable skills</FieldLabel>
                <MultiSelectDropdown
                  id="agent-form-skills"
                  invalid={fieldState.invalid}
                  options={Array.from(skills, ([value, skill]) => ({
                    icon: Wrench,
                    label: skill.name,
                    badge: skill.scope,
                    value,
                  }))}
                  value={field.value.map((skill) => JSON.stringify([skill.scope, skill.name]))}
                  placeholder="Select skills"
                  emptyMessage="No immutable skills"
                  onBlurAction={field.onBlur}
                  onValueChangeAction={(values) => {
                    field.onChange(
                      Array.from(skills)
                        .filter(([key]) => values.includes(key))
                        .map(([, skill]) => skill)
                    )
                  }}
                  aria-describedby="agent-form-skills-error"
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} id="agent-form-skills-error" />
                )}
              </Field>
            )}
          />
          <Controller
            name="instruction"
            control={form.control}
            render={({ field, fieldState }) => {
              const length = Array.from(field.value).length
              const maxLength = 32000
              return (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel>Custom instructions</FieldLabel>
                  <AgentInstructions
                    defaultMarkdown={field.value}
                    markdown={field.value}
                    editorRef={field.ref}
                    onBlurAction={field.onBlur}
                    onChangeAction={field.onChange}
                    readOnly={isPending}
                  />
                  <div
                    className="text-right text-xs text-muted-foreground tabular-nums data-[over-limit=true]:text-destructive"
                    data-over-limit={length > maxLength}
                    aria-label="Instruction character count"
                  >
                    {length.toLocaleString()} / {maxLength.toLocaleString()}
                  </div>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )
            }}
          />
          <FieldSet className="-mx-5 gap-0">
            <FieldLegend className="sr-only">Behavior</FieldLegend>
            <Separator className="h-0 border-t-2 border-dashed border-muted-foreground/50 bg-transparent" />
            <FieldGroup className="gap-4 px-5 pt-4">
              {actionScope.workspaceType !== "coding" && (
                <Controller
                  name="pulseIntervalSeconds"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field orientation="horizontal" data-invalid={fieldState.invalid}>
                      <FieldContent>
                        <FieldLabel htmlFor="agent-form-check-interval">
                          Automatic follow-ups
                        </FieldLabel>
                        <FieldDescription id="agent-form-check-interval-description">
                          Check for updates in Pulse chats.
                        </FieldDescription>
                        <FieldError id="agent-form-check-interval-error">
                          {fieldState.invalid
                            ? "Enter a whole number of minutes between 1 and 10,080."
                            : null}
                        </FieldError>
                      </FieldContent>
                      <InputGroup className="w-28 shrink-0" data-disabled={isPending}>
                        <InputGroupInput
                          id="agent-form-check-interval"
                          ref={field.ref}
                          type="number"
                          min={1}
                          max={10080}
                          step={1}
                          value={Number.isNaN(field.value) ? "" : field.value / 60}
                          onChange={(event) =>
                            field.onChange(event.currentTarget.valueAsNumber * 60)
                          }
                          onBlur={field.onBlur}
                          disabled={isPending}
                          aria-invalid={fieldState.invalid}
                          aria-describedby="agent-form-check-interval-description agent-form-check-interval-error"
                        />
                        <InputGroupAddon align="inline-end">min</InputGroupAddon>
                      </InputGroup>
                    </Field>
                  )}
                />
              )}
              {actionScope.workspaceType !== "coding" && (
                <Controller
                  name="memoryEnabled"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field orientation="horizontal" data-invalid={fieldState.invalid}>
                      <FieldContent>
                        <FieldLabel htmlFor="agent-form-memory">Persistent memory</FieldLabel>
                        <FieldDescription id="agent-form-memory-description">
                          Remember facts across chats.
                        </FieldDescription>
                        <FieldError errors={[fieldState.error]} />
                      </FieldContent>
                      <Switch
                        id="agent-form-memory"
                        ref={field.ref}
                        checked={field.value}
                        onBlur={field.onBlur}
                        onCheckedChange={field.onChange}
                        disabled={isPending}
                        aria-label="Enable persistent memory"
                        aria-invalid={fieldState.invalid}
                        aria-describedby="agent-form-memory-description"
                      />
                    </Field>
                  )}
                />
              )}
              <Controller
                control={form.control}
                name="autoArchiveHours"
                render={({ field, fieldState }) => (
                  <Field orientation="horizontal" data-invalid={fieldState.invalid}>
                    <FieldContent>
                      <FieldLabel htmlFor="autoArchiveHours">Auto-archive idle chats</FieldLabel>
                      <FieldDescription id="agent-form-archive-description">
                        0 to disable auto-archiving.
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </FieldContent>
                    <InputGroup className="w-28 shrink-0" data-disabled={isPending}>
                      <InputGroupInput
                        id="autoArchiveHours"
                        name={field.name}
                        type="number"
                        min={0}
                        max={8760}
                        step={1}
                        value={field.value}
                        onChange={(event) =>
                          field.onChange(event.target.value === "" ? 0 : event.target.valueAsNumber)
                        }
                        onBlur={field.onBlur}
                        ref={field.ref}
                        disabled={isPending}
                        aria-invalid={fieldState.invalid}
                        aria-describedby="agent-form-archive-description"
                      />
                      <InputGroupAddon align="inline-end">hrs</InputGroupAddon>
                    </InputGroup>
                  </Field>
                )}
              />
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
        <aside className="min-w-0 border-2 border-x-0 border-b-0 border-dashed border-muted-foreground/50 bg-muted/20 p-5 md:border-t-0 md:border-l-2 md:pt-0">
          <AgentAppearanceFields control={form.control} disabled={isPending} />
        </aside>
      </form>
      {form.formState.errors.root ? (
        <Alert variant="destructive" className="mx-5 mb-4 w-auto">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            <FieldError errors={[form.formState.errors.root]} />
          </AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="m-0 shrink-0 px-5 py-3">
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={isPending}>
            Cancel
          </Button>
        </DialogClose>
        <LoadingButton
          pending={isPending}
          type="submit"
          form="agent-form-simple"
          disabled={isPending || !hasSandboxes}
        >
          <Save data-icon="inline-start" />
          {mode === "create" ? "Create agent" : "Update agent"}
        </LoadingButton>
      </DialogFooter>
    </>
  )
}
