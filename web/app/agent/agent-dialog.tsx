"use client"

import { LoadingButton } from "@/components/interior/loading-button"
import {
  Fragment,
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useState,
  useId,
  useRef,
} from "react"
import { Controller, useForm, useWatch, type Control } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Box, Plus, Save, Wrench, CircleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import dynamic from "next/dynamic"
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
import { createAgentSimpleFormSchema } from "@/data/schema"
import type { CreateAgentFormState } from "@/data/types"
import type {
  Agent,
  AgentOpencodeConfig,
  ResourceScope,
  Sandbox,
  Skill,
} from "@/lib/gateway/client"
import type * as z from "zod"
import { toast } from "sonner"

const AgentInstructions = dynamic(() => import("./agent-instructions"), {
  ssr: false,
  loading: () => <div className="min-h-18 py-2 text-muted-foreground">Loading editor…</div>,
})

type Mode = "create" | "update"

type AgentDialogProps = {
  mode: Mode
  actionScope: AgentActionScope
  sandboxes: Sandbox[]
  immutableSkills: Skill[]
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  agentName?: string
  initialAppearance?: Agent["appearance"]
  initialSandboxName?: string
  initialMemoryEnabled?: boolean
  initialSkills?: Agent["skills"]
  initialInstruction?: AgentOpencodeConfig["instruction"]
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

type AgentFormValues = z.infer<typeof createAgentSimpleFormSchema>

function AgentAppearanceFields({
  control,
  disabled,
}: {
  control: Control<AgentFormValues>
  disabled: boolean
}) {
  const name = useWatch({ control, name: "name" })
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
            <div className="flex items-center gap-4 pb-4">
              <AgentPresence mascot={value.breed} color={value.color} state="working" size={80} />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="truncate text-base font-semibold">{name || "Your agent"}</div>
                <div className="text-sm text-muted-foreground">
                  {character.name} · {mascotColors[value.color].name}
                </div>
              </div>
            </div>
            <input type="hidden" name="breed" value={value.breed} />
            <input type="hidden" name="color" value={value.color} />
            <FieldGroup className="gap-4">
              <FieldSet>
                <FieldLegend id={`${id}-mascot`} className="sr-only">
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
                      className="w-full cursor-pointer flex-col gap-1.5 rounded-xl border border-border p-2 text-muted-foreground transition-colors hover:bg-muted/50 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-muted/50 has-[[data-state=checked]]:text-foreground"
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
                        size={40}
                      />
                      {mascots[name].name}
                      <span className="min-h-[2lh] text-center text-xs leading-snug font-normal text-muted-foreground">
                        {mascots[name].description}
                      </span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>
              <FieldSet>
                <FieldLegend id={`${id}-color`} className="sr-only">
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
                      className="cursor-pointer rounded-full p-1.5 ring-offset-background transition-shadow hover:ring-2 hover:ring-border has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[[data-state=checked]]:ring-2 has-[[data-state=checked]]:ring-foreground"
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
                          "size-7 rounded-full border border-foreground/10",
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
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
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
  initialAppearance = defaultAgentAppearance,
  initialSandboxName,
  initialMemoryEnabled = false,
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
    sandboxScope: "Organisation",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    skills: initialSkills,
    memoryEnabled: actionScope.workspaceType !== "coding" && initialMemoryEnabled,
    instruction: initialInstruction,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSimpleFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    defaultValues,
  })
  const [, action, isPending] = useActionState<CreateAgentFormState, FormData>(
    async (state, formData) => {
      // Multipart encoding rewrites newlines; pass Markdown as an action argument.
      const instruction = form.getValues("instruction")
      let result: CreateAgentFormState
      try {
        result =
          mode === "update" && agentName
            ? await updateAgentFormAction(actionScope, agentName, instruction, state, formData)
            : await createAgentFormAction(actionScope, instruction, state, formData)
      } catch {
        result = {
          error: { code: "network_error", message: "Could not save the agent. Try again." },
        }
      }
      // A save can finish after dismissal and must not close a newly opened form.
      if (!active.current) return result
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
      return result
    },
    {}
  )
  const selectedSkills = useWatch({
    control: form.control,
    name: "skills",
    defaultValue: initialSkills,
  })
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

  const submit = async (formData: FormData) => {
    form.clearErrors()

    const valid = await form.trigger()
    if (!valid) {
      return
    }

    startTransition(() => {
      action(formData)
    })
  }

  return (
    <>
      <DialogHeader className="shrink-0 px-6 py-5">
        <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
      </DialogHeader>
      <form
        id="agent-form-simple"
        action={submit}
        className="relative grid min-h-0 overflow-y-auto overscroll-contain md:grid-cols-[minmax(0,1fr)_22rem]"
        noValidate
      >
        <input type="hidden" name="sandboxScope" value={sandboxScope} />
        {selectedSkills.map((skill) => (
          <Fragment key={JSON.stringify([skill.scope, skill.name])}>
            <input type="hidden" name="skillScopes" value={skill.scope} />
            <input type="hidden" name="skillNames" value={skill.name} />
          </Fragment>
        ))}
        <FieldGroup className="min-w-0 p-6 pt-0">
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
          {actionScope.workspaceType !== "coding" && (
            <Controller
              name="memoryEnabled"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field orientation="horizontal" data-invalid={fieldState.invalid}>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <FieldLabel htmlFor="agent-form-memory">Persistent memory</FieldLabel>
                    <FieldDescription>
                      Allow this Agent to save facts and journal entries across sessions.
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </div>
                  {field.value ? <input type="hidden" name={field.name} /> : null}
                  <Switch
                    id="agent-form-memory"
                    ref={field.ref}
                    checked={field.value}
                    onBlur={field.onBlur}
                    onCheckedChange={field.onChange}
                    aria-label="Enable persistent memory"
                    aria-invalid={fieldState.invalid}
                  />
                </Field>
              )}
            />
          )}
        </FieldGroup>
        <aside className="min-w-0 border-2 border-x-0 border-b-0 border-dashed border-muted-foreground/50 p-6 md:border-y-0 md:border-l-2 md:pt-0">
          <AgentAppearanceFields control={form.control} disabled={isPending} />
        </aside>
      </form>
      {form.formState.errors.root ? (
        <Alert variant="destructive" className="mx-6 mb-4 w-auto">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            <FieldError errors={[form.formState.errors.root]} />
          </AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="m-0 shrink-0 px-6 py-4">
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
