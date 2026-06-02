"use client"

import Link from "next/link"
import { startTransition, useActionState, useEffect, useEffectEvent, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Plus } from "lucide-react"
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
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import type { Environment } from "@/lib/gateway/client"

type Mode = "create" | "update"

type AgentDialogProps = {
  mode: Mode
  environments: Environment[]
  initialHasNextEnvironmentPage: boolean
  initialNextEnvironmentPageToken: string
  agentName?: string
  initialEnvironmentName?: string
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

type AgentSimpleForm = {
  name?: string
  environmentName: string
}

function uniqueEnvironments(environments: Environment[]) {
  const seen = new Set<string>()
  return environments.filter((environment) => {
    if (seen.has(environment.name)) return false

    seen.add(environment.name)
    return true
  })
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
    const result = await listEnvironmentsAction({
      limit: 50,
      page_token: nextPageToken,
    })
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
            metadata: {
              allowed_host_count: 0,
              package_count: 0,
              referenced_by_agent: false,
            },
            allowed_hosts: [],
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
            className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs"
          >
            {loading ? <Spinner aria-hidden="true" /> : null}
            {loading ? "Loading environments..." : "Scroll for more environments"}
          </div>
        ) : null}
        {error ? <div className="text-destructive px-2 py-1.5 text-xs">{error}</div> : null}
      </SelectContent>
    </Select>
  )
}

export function AgentDialog({
  mode,
  environments,
  initialHasNextEnvironmentPage,
  initialNextEnvironmentPageToken,
  agentName,
  initialEnvironmentName,
  open,
  onOpenChangeAction,
  trigger,
}: AgentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const dialogOpen = open ?? internalOpen
  const hasEnvironments = environments.length > 0
  const formAction =
    mode === "update" && agentName
      ? updateAgentFormAction.bind(null, agentName)
      : createAgentFormAction
  const [state, action, isPending] = useActionState(formAction, {})
  const form = useForm<AgentSimpleForm>({
    resolver: zodResolver(
      mode === "update" ? updateAgentSimpleFormSchema : createAgentSimpleFormSchema
    ),
    defaultValues: {
      name: agentName ?? "",
      environmentName:
        initialEnvironmentName ?? (mode === "create" ? (environments[0]?.name ?? "") : ""),
    },
  })

  const submit = async (formData: FormData) => {
    const valid = await form.trigger()
    if (!valid) return
    startTransition(() => {
      action(formData)
    })
  }

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(nextOpen) => {
        setInternalOpen(nextOpen)
        onOpenChangeAction?.(nextOpen)
      }}
    >
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create an agent with a name and environment."
              : "Update the environment for this agent."}
          </DialogDescription>
        </DialogHeader>
        <form id="agent-form-simple" action={submit} className="space-y-5">
          <FieldGroup>
            {mode === "create" ? (
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
                      aria-invalid={fieldState.invalid}
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
                    initialHasNextPage={initialHasNextEnvironmentPage}
                    initialNextPageToken={initialNextEnvironmentPageToken}
                    onBlurAction={field.onBlur}
                    onValueChangeAction={field.onChange}
                    aria-invalid={fieldState.invalid}
                  />
                  {!hasEnvironments ? (
                    <FieldDescription>
                      Create an environment <Link href="/environments/new">here</Link> before
                      continuing.
                    </FieldDescription>
                  ) : mode === "update" ? (
                    <FieldDescription>
                      Select the replacement environment explicitly. The current environment is not
                      available from the list API.
                    </FieldDescription>
                  ) : null}
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        {state.error ? (
          <div role="alert" className="border-destructive/40 rounded border p-3 text-sm">
            <p className="text-destructive font-medium">{state.error.message}</p>
            {state.error.errors?.length ? (
              <ul className="text-destructive mt-2 list-disc space-y-1 pl-5">
                {state.error.errors.map((error) => (
                  <li key={`${error.field}-${error.message}`}>
                    {error.field}: {error.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="agent-form-simple" disabled={isPending || !hasEnvironments}>
            {isPending ? <Spinner aria-hidden="true" /> : null}
            {mode === "create" ? "Create agent" : "Update agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
