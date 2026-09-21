"use client"

import {
  Fragment,
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useState,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Box, Plus, Save, Wrench, CircleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
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
  enrollComputeAction,
  disconnectComputeAction,
  updateAgentFormAction,
  type AgentActionScope,
} from "@/data/agent.actions"
import { listSandboxesAction } from "@/data/sandbox.actions"
import { createAgentSimpleFormSchema } from "@/data/schema"
import type { CreateAgentFormState } from "@/data/types"
import type { Agent, ComputeEnrollment, ResourceScope, Sandbox, Skill } from "@/lib/gateway/client"
import type * as z from "zod"
import { toast } from "sonner"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"

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
  initialMemoryEnabled?: boolean
  initialAgent?: Agent
  initialSkills?: Agent["skills"]
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

type AgentFormValues = z.infer<typeof createAgentSimpleFormSchema>

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
            className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs"
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
  initialAgent,
  initialSkills = [],
  open,
  onOpenChangeAction,
  trigger,
}: AgentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [nativeAgent, setNativeAgent] = useState<Agent>()
  const router = useRouter()
  const dialogOpen = open ?? internalOpen
  const hasSandboxes = sandboxes.length > 0
  const defaultValues: AgentFormValues = {
    execution: initialAgent?.execution ?? "Kubernetes",
    secretProxy: initialAgent?.secret_proxy ?? true,
    name: agentName ?? "",
    sandboxScope: "Organisation",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    skills: initialSkills,
    memoryEnabled: actionScope.workspaceType !== "coding" && initialMemoryEnabled,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(createAgentSimpleFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    defaultValues,
  })
  const [, action, isPending] = useActionState<CreateAgentFormState, FormData>(
    async (state, formData) => {
      const result =
        mode === "update" && agentName
          ? await updateAgentFormAction(actionScope, agentName, state, formData)
          : await createAgentFormAction(actionScope, state, formData)
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
            case "memory":
            case "memoryEnabled":
              field = "memoryEnabled"
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
      if (result.success && result.agent?.execution === "Native") {
        setNativeAgent(result.agent)
        router.refresh()
        return result
      }
      if (result.success) {
        toast.success(mode === "update" ? "Agent updated" : "Agent created")
        onOpenChangeAction?.(false)
        setInternalOpen(false)
        router.refresh()
      }
      return result
    },
    {}
  )
  const execution = useWatch({ control: form.control, name: "execution" })
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

  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setNativeAgent(undefined)
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
      <DialogContent className={mode === "update" ? "sm:max-w-md" : undefined}>
        {nativeAgent ? (
          <NativeSetup agent={nativeAgent} workspaceId={actionScope.workspaceId} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
              <DialogDescription>
                {mode === "create"
                  ? "Create an agent with a name and sandbox."
                  : "Update the sandbox and immutable skills for this agent."}
              </DialogDescription>
            </DialogHeader>
            <form id="agent-form-simple" action={submit} className="space-y-5">
              <input type="hidden" name="sandboxScope" value={sandboxScope} />
              {selectedSkills.map((skill) => (
                <Fragment key={JSON.stringify([skill.scope, skill.name])}>
                  <input type="hidden" name="skillScopes" value={skill.scope} />
                  <input type="hidden" name="skillNames" value={skill.name} />
                </Fragment>
              ))}
              <FieldGroup>
                {mode === "create" ? (
                  <Controller
                    name="execution"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="agent-execution">Compute</FieldLabel>
                        <Select
                          name={field.name}
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger id="agent-execution">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Kubernetes">Hosted by AgentZ</SelectItem>
                            <SelectItem value="Native">My Linux host</SelectItem>
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          {field.value === "Native"
                            ? "Your machine, the same AgentZ tools and workflows. Nothing runs in containers."
                            : "AgentZ provisions and manages the runtime."}
                        </FieldDescription>
                      </Field>
                    )}
                  />
                ) : (
                  <input type="hidden" name="execution" value={execution} />
                )}
                {execution === "Native" ? (
                  <Controller
                    name="secretProxy"
                    control={form.control}
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <div>
                          <FieldLabel htmlFor="agent-secret-proxy">
                            Inject platform secrets
                          </FieldLabel>
                          <FieldDescription>
                            Use the secret proxy for CLI credentials. Turn off to use credentials
                            already on your host. MCP always uses the gateway.
                          </FieldDescription>
                        </div>
                        <input
                          type="hidden"
                          name="secretProxy"
                          disabled={!field.value}
                          value="on"
                        />
                        <Switch
                          id="agent-secret-proxy"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </Field>
                    )}
                  />
                ) : (
                  <input type="hidden" name="secretProxy" value="on" />
                )}

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
                        value={field.value.map((skill) =>
                          JSON.stringify([skill.scope, skill.name])
                        )}
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
                      />
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
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
            </form>
            {form.formState.errors.root ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>
                  <FieldError errors={[form.formState.errors.root]} />
                </AlertDescription>
              </Alert>
            ) : null}
            {initialAgent?.execution === "Native" ? (
              <Button type="button" variant="outline" onClick={() => setNativeAgent(initialAgent)}>
                Manage Linux host
              </Button>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" form="agent-form-simple" disabled={isPending || !hasSandboxes}>
                {isPending ? <Spinner aria-hidden="true" /> : <Save data-icon="inline-start" />}
                {mode === "create" ? "Create agent" : "Update agent"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function NativeSetup({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const { data: hosts } = useQuery(watchAgentsQueryOptions(workspaceId, [agent], [agent.name]))
  const host = hosts?.[0] ?? agent
  const [enrollment, setEnrollment] = useState<ComputeEnrollment>()
  const [backend, setBackend] = useState("")
  const [release, setRelease] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let active = true
    getGatewayBaseURL()
      .then((value) => {
        if (active) setBackend(value ?? "")
      })
      .catch(() => {
        if (active) setError("Could not load the backend address")
      })
    return () => {
      active = false
    }
  }, [])
  async function enroll() {
    setPending(true)
    setError("")
    try {
      const result = await enrollComputeAction(workspaceId, agent.name)
      if (result.error) setError(result.error.message)
      else setEnrollment(result.data)
    } catch {
      setError("Could not generate an enrollment code")
    } finally {
      setPending(false)
    }
  }
  let title = "Bring your agent home"
  if (host.hostname) title = "Your host is offline"
  if (host.connected) title = "Your host is connected"
  const command =
    /^v\d+\.\d+\.\d+$/.test(release) && backend.startsWith("https://")
      ? `sudo bash install.sh '${backend.replaceAll("'", "'\\''")}' '${release}' "$USER" "$HOME/agentz" "${"${XDG_CONFIG_HOME:-$HOME/.config}"}" "${"${XDG_DATA_HOME:-$HOME/.local/share}"}" "${"${XDG_STATE_HOME:-$HOME/.local/state}"}" "${"${XDG_CACHE_HOME:-$HOME/.cache}"}"`
      : ""
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {agent.name} uses your Linux host with your user account and files. Start with a systemd
          host and sudo access.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-5">
        <div className="rounded-lg border p-4" role="status">
          <p className="font-medium">{host.hostname || "Waiting for your host"}</p>
          <p className="text-muted-foreground text-sm">
            {host.connected
              ? `Runtime: ${host.status}. Work directory: ${host.runtime_root}`
              : "Existing local work continues if the connection drops. New remote work is unavailable while the host is offline."}
          </p>
        </div>
        {!host.connected && !host.hostname ? (
          <>
            <p className="text-sm">
              Download{" "}
              <a
                className="underline"
                href="https://github.com/accuknox/agentz/releases"
                target="_blank"
                rel="noreferrer"
              >
                the installer from an AgentZ release
              </a>
              . The installer verifies the release and installs SPIRE, KubeArmor, Nix, and the
              native runtime.
            </p>
            {backend && !backend.startsWith("https://") ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Host enrollment requires an HTTPS gateway address. Configure the public gateway
                  URL before installing.
                </AlertDescription>
              </Alert>
            ) : null}
            <Field>
              <FieldLabel htmlFor="native-release">Release version</FieldLabel>
              <Input
                id="native-release"
                placeholder="v0.3.0"
                value={release}
                onChange={(event) => setRelease(event.target.value)}
              />
            </Field>
            {command ? (
              <div className="space-y-2">
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{command}</pre>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(command)}
                >
                  Copy install command
                </Button>
              </div>
            ) : null}
            <Button type="button" disabled={pending} onClick={enroll}>
              {pending ? <Spinner /> : null}
              {enrollment ? "Generate a fresh code" : "Generate enrollment code"}
            </Button>
            {enrollment ? (
              <div className="space-y-2 rounded-lg border p-4">
                <p className="text-sm">
                  Paste this code when the installer asks. It works once and expires in 15 minutes.
                </p>
                <code className="block text-sm break-all">{enrollment.code}</code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(enrollment.code)}
                >
                  Copy enrollment code
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        {!host.connected && host.hostname ? (
          <div className="space-y-2 text-sm">
            <p>Turn on your host to reconnect. If it is already running, check its connection:</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              sudo /usr/local/lib/agentz/agentz daemon doctor
            </pre>
          </div>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={async () => {
            setPending(true)
            try {
              const result = await disconnectComputeAction(workspaceId, agent.name)
              if (result.error) setError(result.error.message)
              else {
                setEnrollment(undefined)
              }
            } catch {
              setError("Could not disconnect the host")
            } finally {
              setPending(false)
            }
          }}
        >
          Disconnect host
        </Button>
        <p className="text-muted-foreground text-xs">
          Before enrolling this host again, run{" "}
          <code>sudo /usr/local/lib/agentz/agentz daemon unenroll</code> on it. Your work files are
          preserved.
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Done
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  )
}
