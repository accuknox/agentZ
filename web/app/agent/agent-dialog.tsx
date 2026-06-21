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
import { listEnvironmentsAction } from "@/data/environment.actions"
import { createAgentSimpleFormSchema, updateAgentSimpleFormSchema } from "@/data/schema"
import type { Environment } from "@/lib/gateway/client"
import { createAgentOpencodeClientV2 } from "@/lib/opencode/client"
import type { ComponentType, SVGProps } from "react"

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
  model?: string
  smallModel?: string
}

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
  const [environments, setEnvironments] = useState(() => {
    return Array.from(
      new Map(initialEnvironments.map((environment) => [environment.name, environment])).values()
    )
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
    const result = await listEnvironmentsAction({
      limit: 50,
      page_token: nextPageToken,
    })
    setLoading(false)

    if (result.error) {
      setError(result.error.message)
      return
    }

    setEnvironments((current) => {
      return Array.from(
        new Map(
          [...current, ...result.environments].map((environment) => [environment.name, environment])
        ).values()
      )
    })
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
  const router = useRouter()
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
      model: undefined,
      smallModel: undefined,
    },
  })
  const modelCatalog = useQuery(
    queryOptions({
      queryKey: ["agent", "edit-models", agentName],
      queryFn: async () => {
        if (!agentName) {
          throw new Error("Agent name is required")
        }

        const client = await createAgentOpencodeClientV2(agentName)
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

  const submit = async (formData: FormData) => {
    const valid = await form.trigger()
    if (!valid) return
    startTransition(() => {
      action(formData)
    })
  }

  const onOpenChange = (nextOpen: boolean) => {
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
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New agent" : "Update agent"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create an agent with a name and environment."
              : "Update the environment and live model settings for this agent."}
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
              name="environmentName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="agent-form-environment" required>
                    Environment
                  </FieldLabel>
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
                    aria-required="true"
                  />
                  {!hasEnvironments ? (
                    <FieldDescription>
                      Create an environment{" "}
                      <button
                        type="button"
                        className="text-foreground underline"
                        onClick={() => {
                          onOpenChange(false)
                          router.push("/environments/new")
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
