"use client"

import { startTransition, useActionState, useEffect, useEffectEvent, useState } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Plus } from "lucide-react"
import { useRouter } from "next/navigation"
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
import { createAgentFormAction, updateAgentFormAction } from "@/data/agent.actions"
import { listSandboxesAction } from "@/data/sandbox.actions"
import { createAgentSimpleFormSchema } from "@/data/schema"
import type { Sandbox, Skill } from "@/lib/gateway/client"
import type * as z from "zod"

type Mode = "create" | "update"

type AgentDialogProps = {
  mode: Mode
  sandboxes: Sandbox[]
  immutableSkills: Skill[]
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  agentName?: string
  initialSandboxName?: string
  initialMemoryEnabled?: boolean
  initialSkills?: string[] | null
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

const agentDialogFormSchema = createAgentSimpleFormSchema

type AgentFormValues = z.infer<typeof agentDialogFormSchema>

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
    const result = await listSandboxesAction({
      limit: 50,
      page_token: nextPageToken,
    })
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
              {sandbox.name}
            </SelectItem>
          ))}
        </SelectGroup>
        {hasNextPage ? (
          <div
            ref={setSentinel}
            className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs"
          >
            {loading ? <Spinner aria-hidden="true" /> : null}
            {loading ? "Loading sandboxes..." : "Scroll for more sandboxes"}
          </div>
        ) : null}
        {error ? <div className="text-destructive px-2 py-1.5 text-xs">{error}</div> : null}
      </SelectContent>
    </Select>
  )
}

export function AgentDialog({
  mode,
  sandboxes,
  immutableSkills,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  agentName,
  initialSandboxName,
  initialMemoryEnabled = false,
  initialSkills = [],
  open,
  onOpenChangeAction,
  trigger,
}: AgentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const router = useRouter()
  const dialogOpen = open ?? internalOpen
  const skills = initialSkills ?? []
  const hasSandboxes = sandboxes.length > 0
  const formAction =
    mode === "update" && agentName
      ? updateAgentFormAction.bind(null, agentName)
      : createAgentFormAction
  const [state, action, isPending] = useActionState(formAction, {})
  const defaultValues: AgentFormValues = {
    name: agentName ?? "",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    skills,
    memoryEnabled: initialMemoryEnabled,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentDialogFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    defaultValues,
  })
  const selectedSkills = useWatch({
    control: form.control,
    name: "skills",
    defaultValue: skills,
  })

  useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const error of state.error.errors) {
      let field: keyof AgentFormValues | undefined
      switch (error.field) {
        case "name":
        case "sandboxName":
        case "skills":
          field = error.field
          break
      }
      if (!field) {
        continue
      }

      form.setError(field, {
        type: "server",
        message: error.message,
      })
    }
  }, [form, state.error])

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

  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      form.reset(defaultValues)
      form.clearErrors()
    }

    setInternalOpen(nextOpen)
    onOpenChangeAction?.(nextOpen)
  }

  const fieldErrorCount =
    state.error?.errors?.filter((error) => {
      return error.field === "name" || error.field === "sandboxName" || error.field === "skills"
    }).length ?? 0
  const generalErrorMessage =
    state.error && fieldErrorCount !== (state.error.errors?.length ?? 0)
      ? state.error.message
      : !state.error?.errors?.length
        ? state.error?.message
        : undefined

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
      <DialogContent className={mode === "update" ? "sm:max-w-md" : undefined}>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create an agent with a name and sandbox."
              : "Update the sandbox and immutable skills for this agent."}
          </DialogDescription>
        </DialogHeader>
        <form id="agent-form-simple" action={submit} className="space-y-5">
          {selectedSkills.map((skill) => (
            <input key={skill} type="hidden" name="skills" value={skill} />
          ))}
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
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
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
                          router.push("/sandboxes/new")
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
                    options={immutableSkills.map((skill) => ({
                      label: skill.name,
                      value: skill.name,
                    }))}
                    value={field.value}
                    placeholder="Select skills"
                    emptyMessage="No immutable skills"
                    onBlurAction={field.onBlur}
                    onValueChangeAction={field.onChange}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              name="memoryEnabled"
              control={form.control}
              render={({ field }) => (
                <Field orientation="horizontal">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <FieldLabel htmlFor="agent-form-memory">Persistent memory</FieldLabel>
                    <FieldDescription>
                      Let this agent curate durable facts and keep a work journal.
                    </FieldDescription>
                  </div>
                  {field.value ? <input type="hidden" name={field.name} /> : null}
                  <Switch
                    id="agent-form-memory"
                    ref={field.ref}
                    checked={field.value}
                    onBlur={field.onBlur}
                    onCheckedChange={field.onChange}
                    aria-label="Enable persistent memory"
                  />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        {generalErrorMessage ? (
          <div role="alert" className="border-destructive/40 rounded border p-3 text-sm">
            <p className="text-destructive font-medium">{generalErrorMessage}</p>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="agent-form-simple" disabled={isPending || !hasSandboxes}>
            {isPending ? <Spinner aria-hidden="true" /> : null}
            {mode === "create" ? "Create agent" : "Update agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
