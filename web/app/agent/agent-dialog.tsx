"use client"

import { startTransition, useActionState, useEffect, useEffectEvent, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  AmazonWebServicesDark,
  AmazonWebServicesLight,
  AnthropicDark,
  AnthropicLight,
  CerebrasDark,
  CerebrasLight,
  Cloudflare,
  GitHubCopilotDark,
  GitHubCopilotLight,
  GitHubDark,
  GitHubLight,
  Google,
  Groq,
  HuggingFace,
  MistralAI,
  OpenCodeDark as OpenCodeLight,
  OpenCodeLight as OpenCodeDark,
  OpenAIDark,
  OpenAILight,
  OpenRouterDark,
  OpenRouterLight,
  PerplexityAI,
  TogetherAIDark,
  TogetherAILight,
  VercelDark,
  VercelLight,
} from "@ridemountainpig/svgl-react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
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
import { listSandboxesAction } from "@/data/sandbox.actions"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import type { Sandbox } from "@/lib/gateway/client"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import type { ComponentType, SVGProps } from "react"
import type * as z from "zod"

type Mode = "create" | "update"

type AgentDialogProps = {
  mode: Mode
  sandboxes: Sandbox[]
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  agentName?: string
  initialSandboxName?: string
  open?: boolean
  onOpenChangeAction?: (open: boolean) => void
  trigger?: React.ReactNode
}

const agentDialogFormSchema = createAgentSimpleFormSchema.extend({
  model: updateAgentSimpleFormSchema.shape.model,
  smallModel: updateAgentSimpleFormSchema.shape.smallModel,
})

type AgentFormValues = z.infer<typeof agentDialogFormSchema>

function themedIcon(
  darkThemeIcon: ComponentType<SVGProps<SVGSVGElement>>,
  lightThemeIcon: ComponentType<SVGProps<SVGSVGElement>>
): ComponentType<SVGProps<SVGSVGElement>> {
  return function ThemedIcon(props: SVGProps<SVGSVGElement>) {
    const { resolvedTheme } = useTheme()
    const Icon = resolvedTheme === "dark" ? darkThemeIcon : lightThemeIcon

    return <Icon {...props} />
  }
}

const providerLogos: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  "amazon-bedrock": themedIcon(AmazonWebServicesDark, AmazonWebServicesLight),
  anthropic: themedIcon(AnthropicDark, AnthropicLight),
  cerebras: themedIcon(CerebrasDark, CerebrasLight),
  "cloudflare-workers-ai": Cloudflare,
  "github-copilot": themedIcon(GitHubCopilotDark, GitHubCopilotLight),
  "github-models": themedIcon(GitHubDark, GitHubLight),
  google: Google,
  "google-vertex": Google,
  "google-vertex-anthropic": Google,
  groq: Groq,
  huggingface: HuggingFace,
  mistral: MistralAI,
  opencode: themedIcon(OpenCodeDark, OpenCodeLight),
  "opencode-go": themedIcon(OpenCodeDark, OpenCodeLight),
  openai: themedIcon(OpenAIDark, OpenAILight),
  openrouter: themedIcon(OpenRouterDark, OpenRouterLight),
  perplexity: PerplexityAI,
  togetherai: themedIcon(TogetherAIDark, TogetherAILight),
  vercel: themedIcon(VercelDark, VercelLight),
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
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  agentName,
  initialSandboxName,
  open,
  onOpenChangeAction,
  trigger,
}: AgentDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const router = useRouter()
  const dialogOpen = open ?? internalOpen
  const hasSandboxes = sandboxes.length > 0
  const formAction =
    mode === "update" && agentName
      ? updateAgentFormAction.bind(null, agentName)
      : createAgentFormAction
  const [state, action, isPending] = useActionState(formAction, {})
  const defaultValues: AgentFormValues = {
    name: agentName ?? "",
    sandboxName: initialSandboxName ?? (mode === "create" ? (sandboxes[0]?.name ?? "") : ""),
    model: undefined,
    smallModel: undefined,
  }
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentDialogFormSchema),
    mode: "onSubmit",
    reValidateMode: "onBlur",
    defaultValues,
  })
  const modelCatalog = useQuery(
    queryOptions({
      queryKey: ["agent", "edit-models", agentName],
      queryFn: async () => {
        if (!agentName) {
          throw new Error("Agent name is required")
        }

        const client = await createAgentOpencodeClient(agentName)
        const [providersResult, configResult] = await Promise.all([
          client.config.providers(),
          client.config.get(),
        ])

        if (providersResult.error || !providersResult.data) {
          throw new Error("Failed to load providers")
        }
        if (configResult.error || !configResult.data) {
          throw new Error("Failed to load config")
        }

        const models = providersResult.data.providers.flatMap((provider) => {
          return Object.values(provider.models).flatMap((model) => {
            if (!model.id || !provider.id) {
              return []
            }

            return [
              {
                modelName: model.name ?? model.id,
                providerID: provider.id,
                providerName: provider.name,
                value: `${provider.id}/${model.id}`,
              },
            ]
          })
        })

        const currentModels = [configResult.data.model, configResult.data.small_model]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .filter((value, index, values) => values.indexOf(value) === index)
          .flatMap((value) => {
            if (models.some((model) => model.value === value)) {
              return []
            }

            const [providerID, ...modelID] = value.split("/")
            if (!providerID || modelID.length === 0) {
              return []
            }

            return [
              {
                modelName: modelID.join("/"),
                providerID,
                providerName: providerID,
                value,
              },
            ]
          })

        return {
          model: configResult.data.model,
          models: [...currentModels, ...models],
          smallModel: configResult.data.small_model,
        }
      },
      enabled: mode === "update" && dialogOpen && !!agentName,
      staleTime: 60_000,
    })
  )
  const showModelFields = mode === "update"

  useEffect(() => {
    if (!modelCatalog.data) {
      return
    }

    form.reset({
      ...form.getValues(),
      model: modelCatalog.data.model,
      smallModel: modelCatalog.data.smallModel,
    })
  }, [form, modelCatalog.data])

  useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const error of state.error.errors) {
      if (
        error.field !== "name" &&
        error.field !== "sandboxName" &&
        error.field !== "model" &&
        error.field !== "smallModel"
      ) {
        continue
      }

      form.setError(error.field, {
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
      return (
        error.field === "name" ||
        error.field === "sandboxName" ||
        error.field === "model" ||
        error.field === "smallModel"
      )
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
              : "Update the sandbox and live model settings for this agent."}
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
            {showModelFields ? (
              <>
                <Controller
                  name="model"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="agent-form-model">Default model</FieldLabel>
                      <Select
                        name={field.name}
                        value={field.value}
                        disabled={!modelCatalog.data}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger
                          id="agent-form-model"
                          onBlur={field.onBlur}
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue placeholder="Select a default model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {modelCatalog.data?.models.map((model) => (
                              <SelectItem key={model.value} value={model.value}>
                                <span className="flex items-center gap-2">
                                  {providerLogos[model.providerID] ? (
                                    (() => {
                                      const Logo = providerLogos[model.providerID]
                                      return <Logo className="size-4 shrink-0" />
                                    })()
                                  ) : (
                                    <span className="text-muted-foreground shrink-0">
                                      {model.providerName} /
                                    </span>
                                  )}
                                  <span>{model.modelName}</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
                <Controller
                  name="smallModel"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="agent-form-small-model">Small model</FieldLabel>
                      <Select
                        name={field.name}
                        value={field.value}
                        disabled={!modelCatalog.data}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger
                          id="agent-form-small-model"
                          onBlur={field.onBlur}
                          aria-invalid={fieldState.invalid}
                          className="w-full"
                        >
                          <SelectValue placeholder="Select a small model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {modelCatalog.data?.models.map((model) => (
                              <SelectItem key={model.value} value={model.value}>
                                <span className="flex items-center gap-2">
                                  {providerLogos[model.providerID] ? (
                                    (() => {
                                      const Logo = providerLogos[model.providerID]
                                      return <Logo className="size-4 shrink-0" />
                                    })()
                                  ) : (
                                    <span className="text-muted-foreground shrink-0">
                                      {model.providerName} /
                                    </span>
                                  )}
                                  <span>{model.modelName}</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
              </>
            ) : null}
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
