"use client"

import { LoadingButton } from "@/components/interior/loading-button"
import { useEffect, useEffectEvent, useState, useTransition } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { createAgentSimpleFormSchema, type AgentFormValues } from "@/data/schema"
import type {
  Agent,
  AgentOpencodeConfig,
  ResourceScope,
  Sandbox,
  Skill,
} from "@/lib/gateway/client"
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
  initialSandboxName?: string
  initialAutomaticCheckIntervalSeconds?: Agent["automatic_check_interval_seconds"]
  initialMemoryEnabled?: boolean
  initialSkills?: Agent["skills"]
  initialInstruction?: AgentOpencodeConfig["instruction"]
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
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

  const selectedIsLoaded = sandboxes.some((sandbox) => sandbox.name === value)
  const options =
    value && !selectedIsLoaded
      ? [
          {
            name: value,
            packages: [],
            created_at: "",
            metadata: {
              allowed_host_count: 0,
              package_count: 0,
              referenced_by_agent: false,
            },
            allowed_hosts: [],
          },
          ...sandboxes,
        ]
      : sandboxes

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
          {options.map((sandbox) => (
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

export function AgentDialog({
  actionScope,
  mode,
  sandboxes,
  immutableSkills,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  agentName,
  initialSandboxName,
  initialMemoryEnabled = false,
  initialAutomaticCheckIntervalSeconds = 1800,
  initialSkills = [],
  initialInstruction = "",
  open,
  onOpenChangeAction,
  trigger,
}: AgentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const dialogOpen = open ?? internalOpen
  const hasSandboxes = sandboxes.length > 0
  const defaultValues: AgentFormValues = {
    name: agentName ?? "",
    sandboxScope: "Organisation",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    skills: initialSkills,
    memoryEnabled: actionScope.workspaceType !== "coding" && initialMemoryEnabled,
    automaticCheckIntervalSeconds: initialAutomaticCheckIntervalSeconds,
    instruction: initialInstruction,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSimpleFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    values: defaultValues,
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

  const submit = async () => {
    form.clearErrors()
    const valid = await form.trigger()
    if (!valid) return

    const values = { ...form.getValues(), sandboxScope }
    startTransition(async () => {
      const result =
        mode === "update" && agentName
          ? await updateAgentFormAction(actionScope, agentName, values)
          : await createAgentFormAction(actionScope, values)
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
            case "skills":
              field = "skills"
              break
            case "sandbox":
            case "sandboxScope":
            case "sandboxName":
              field = "sandboxName"
              break
            case "automatic_check_interval_seconds":
            case "automaticCheckIntervalSeconds":
              field = "automaticCheckIntervalSeconds"
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
        form.reset(defaultValues)
        toast.success(mode === "update" ? "Agent updated" : "Agent created")
        onOpenChangeAction?.(false)
        setInternalOpen(false)
        router.refresh()
      }
    })
  }

  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      form.reset(defaultValues)
      form.clearErrors()
    }

    setInternalOpen(nextOpen)
    onOpenChangeAction?.(nextOpen)
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : mode === "create" ? (
        <DialogTrigger asChild>
          <Button>
            <Plus />
            New agent
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create an agent with a name and sandbox."
              : "Update this agent's configuration."}
          </DialogDescription>
        </DialogHeader>
        <form id="agent-form-simple" action={submit} className="space-y-5" noValidate>
          <FieldGroup>
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
                          onOpenChange(false)
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
                      key={initialInstruction}
                      defaultMarkdown={initialInstruction}
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
                name="automaticCheckIntervalSeconds"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="agent-form-check-interval">
                      Automatic check interval
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input
                        id="agent-form-check-interval"
                        ref={field.ref}
                        type="number"
                        min={1}
                        max={10080}
                        step={1}
                        value={Number.isNaN(field.value) ? "" : field.value / 60}
                        onChange={(event) => field.onChange(event.currentTarget.valueAsNumber * 60)}
                        onBlur={field.onBlur}
                        disabled={isPending}
                        aria-invalid={fieldState.invalid}
                        aria-describedby="agent-form-check-interval-description agent-form-check-interval-error"
                        className="w-24"
                      />
                      <span className="text-muted-foreground">minutes</span>
                    </div>
                    <FieldDescription id="agent-form-check-interval-description">
                      Applies to all long-running conversations with this agent. Each conversation
                      can be paused independently.
                    </FieldDescription>
                    <FieldError id="agent-form-check-interval-error">
                      {fieldState.invalid
                        ? "Enter a whole number of minutes between 1 and 10,080."
                        : null}
                    </FieldError>
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
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <FieldLabel htmlFor="agent-form-memory">Persistent memory</FieldLabel>
                      <FieldDescription>
                        Allow this Agent to save facts and journal entries across sessions.
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </div>
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
        </form>
        {form.formState.errors.root ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              <FieldError errors={[form.formState.errors.root]} />
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
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
      </DialogContent>
    </Dialog>
  )
}
