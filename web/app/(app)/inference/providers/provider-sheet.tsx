"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import {
  Brain,
  Cable,
  Check,
  ChevronsUpDown,
  CircleAlert,
  KeyRound,
  Pencil,
  Plus,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import * as React from "react"
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type UseFormRegisterReturn,
} from "react-hook-form"
import { toast } from "sonner"
import * as z from "zod"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  listInferenceProviderCatalogAction,
  getInferenceProviderUsageAction,
  saveInferenceProviderAction,
  suggestInferenceModelsAction,
} from "@/data/inference-provider.actions"
import { formatCompactNumber } from "@/lib/format"
import {
  type CreateInferenceProviderRequestWritable,
  type InferenceModel,
  type InferenceModelModality,
  type InferenceProvider,
  type InferenceProviderCatalogEntry,
} from "@/lib/gateway/client"
import {
  zCompatibleProviderConfig,
  zCreateInferenceProviderRequestWritable,
} from "@/lib/gateway/client/zod.gen"
import { ProviderIcon, providerKindLabels } from "./provider-shared"
import { cn } from "@/lib/utils"

const blankModel: InferenceModel = {
  id: "",
  display_name: "",
  capabilities: { attachment: false, reasoning: false, temperature: true, tool_call: true },
  modalities: { input: ["text"], output: ["text"] },
  limits: { context: 128000, output: 16384 },
}

const modalities = [
  "text",
  "audio",
  "image",
  "video",
  "pdf",
] as const satisfies readonly InferenceModelModality[]

const capabilities = ["attachment", "reasoning", "temperature", "tool_call"] as const

const gatewayControlledHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
])

const credentialHeaders = new Set([
  "api-key",
  "authorization",
  "x-amz-security-token",
  "x-api-key",
  "x-goog-api-key",
])

const providerModelSchema = z.object({
  id: z
    .string({ error: "Model ID is required" })
    .min(1, { error: "Model ID is required" })
    .max(512, { error: "Model ID must be at most 512 characters" }),
  display_name: z
    .string({ error: "Model display name is required" })
    .min(1, { error: "Model display name is required" })
    .max(128, { error: "Model display name must be at most 128 characters" }),
  capabilities: z.object({
    attachment: z.boolean({ error: "Attachment capability must be enabled or disabled" }),
    reasoning: z.boolean({ error: "Reasoning capability must be enabled or disabled" }),
    temperature: z.boolean({ error: "Temperature capability must be enabled or disabled" }),
    tool_call: z.boolean({ error: "Tool-call capability must be enabled or disabled" }),
  }),
  modalities: z.object({
    input: z
      .array(z.enum(modalities, { error: "Select a supported input modality" }), {
        error: "Input modalities must be a list",
      })
      .min(1, { error: "Select at least one input modality" }),
    output: z
      .array(z.enum(modalities, { error: "Select a supported output modality" }), {
        error: "Output modalities must be a list",
      })
      .min(1, { error: "Select at least one output modality" }),
  }),
  limits: z.object({
    context: z
      .int({ error: "Context limit must be a whole number" })
      .gte(1, { error: "Context limit must be at least 1" })
      .lte(2147483647, { error: "Context limit must be at most 2,147,483,647" }),
    input: z
      .int({ error: "Maximum input tokens must be a whole number" })
      .gte(1, { error: "Maximum input tokens must be at least 1" })
      .lte(2147483647, { error: "Maximum input tokens must be at most 2,147,483,647" })
      .optional(),
    output: z
      .int({ error: "Maximum output tokens must be a whole number" })
      .gte(1, { error: "Maximum output tokens must be at least 1" })
      .lte(2147483647, { error: "Maximum output tokens must be at most 2,147,483,647" }),
  }),
  catalog_provider: z
    .string({ error: "Catalog provider must be text" })
    .min(1, { error: "Catalog provider is required" })
    .max(128, { error: "Catalog provider must be at most 128 characters" })
    .optional(),
})

const providerFields = {
  catalog_provider: z
    .string({ error: "Provider is required" })
    .min(1, { error: "Select a provider" })
    .max(128, { error: "Provider ID must be at most 128 characters" }),
  display_name: z
    .string({ error: "Display name is required" })
    .min(1, { error: "Display name is required" })
    .max(128, { error: "Display name must be at most 128 characters" }),
  models: z
    .array(providerModelSchema, { error: "Models must be a list" })
    .min(1, { error: "Select at least one model" })
    .max(500, { error: "Select at most 500 models" }),
}

const baseURLSchema = z
  .url({ error: "Enter a valid base URL" })
  .max(2048, { error: "Base URL must be at most 2,048 characters" })
  .optional()

const apiKeyCredentialsSchema = z.object({
  api_key: z
    .string({ error: "API key must be text" })
    .max(49152, { error: "API key must be at most 48 KB" })
    .optional(),
})

const serviceAccountDocumentSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().min(1),
  private_key: z.string().min(1),
  client_email: z.string().min(1),
  token_uri: z.string().min(1),
})

const providerFormSchema = z
  .discriminatedUnion(
    "kind",
    [
      z.object({
        ...providerFields,
        kind: z.literal("OpenAI", { error: "Select OpenAI as the provider kind" }),
        openai: z.object({ base_url: baseURLSchema }),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        kind: z.literal("Anthropic", { error: "Select Anthropic as the provider kind" }),
        anthropic: z.object({ base_url: baseURLSchema }),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        kind: z.literal("Gemini", { error: "Select Gemini as the provider kind" }),
        gemini: z.object({ base_url: baseURLSchema }),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        kind: z.literal("VertexAI", { error: "Select Vertex AI as the provider kind" }),
        vertex_ai: z.object({
          project: z
            .string({ error: "Project is required" })
            .min(1, { error: "Project is required" })
            .max(128, { error: "Project must be at most 128 characters" }),
          region: z
            .string({ error: "Region is required" })
            .min(1, { error: "Region is required" })
            .max(64, { error: "Region must be at most 64 characters" }),
        }),
        credentials: z.object({
          service_account_json: z
            .string({ error: "Service account JSON must be text" })
            .max(49152, { error: "Service account JSON must be at most 48 KB" })
            .optional(),
        }),
      }),
      z.object({
        ...providerFields,
        kind: z.literal("Bedrock", { error: "Select Bedrock as the provider kind" }),
        bedrock: z.object({
          auth_mode: z.enum(["AccessKey", "BearerToken"], {
            error: "Select access-key or bearer-token authentication",
          }),
          region: z
            .string({ error: "Region is required" })
            .min(1, { error: "Region is required" })
            .max(63, { error: "Region must be at most 63 characters" })
            .regex(/^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$/, {
              error: "Enter a valid AWS region such as us-east-1",
            }),
        }),
        credentials: z.object({
          access_key: z
            .string({ error: "Access key must be text" })
            .max(49152, { error: "Access key must be at most 48 KB" })
            .optional(),
          secret_key: z
            .string({ error: "Secret key must be text" })
            .max(49152, { error: "Secret key must be at most 48 KB" })
            .optional(),
          session_token: z
            .string({ error: "Session token must be text" })
            .max(49152, { error: "Session token must be at most 48 KB" })
            .optional(),
          bearer_token: z
            .string({ error: "Bearer token must be text" })
            .max(49152, { error: "Bearer token must be at most 48 KB" })
            .optional(),
        }),
      }),
      z.object({
        ...providerFields,
        kind: z.literal("Azure", { error: "Select Azure as the provider kind" }),
        azure: z.object({
          resource_type: z.enum(["OpenAI", "Foundry"], {
            error: "Select Azure OpenAI or Azure AI Foundry",
          }),
          resource_name: z
            .string({ error: "Resource name is required" })
            .min(1, { error: "Resource name is required" })
            .max(64, { error: "Resource name must be at most 64 characters" }),
          project: z
            .string({ error: "Foundry project must be text" })
            .min(1, { error: "Foundry project is required" })
            .max(64, { error: "Foundry project must be at most 64 characters" })
            .optional(),
          api_version: z
            .string({ error: "API version is required" })
            .min(1, { error: "API version is required" })
            .max(64, { error: "API version must be at most 64 characters" }),
          auth_mode: z.enum(["APIKey", "ServicePrincipal"], {
            error: "Select API key or service-principal authentication",
          }),
        }),
        credentials: z.object({
          api_key: apiKeyCredentialsSchema.shape.api_key,
          client_id: z
            .string({ error: "Client ID must be text" })
            .max(49152, { error: "Client ID must be at most 48 KB" })
            .optional(),
          tenant_id: z
            .string({ error: "Tenant ID must be text" })
            .max(49152, { error: "Tenant ID must be at most 48 KB" })
            .optional(),
          client_secret: z
            .string({ error: "Client secret must be text" })
            .max(49152, { error: "Client secret must be at most 48 KB" })
            .optional(),
        }),
      }),
      z.object({
        ...providerFields,
        kind: z.literal("OpenAICompatible", {
          error: "Select OpenAI-compatible as the provider kind",
        }),
        openai_compatible: zCompatibleProviderConfig,
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        kind: z.literal("AnthropicCompatible", {
          error: "Select Anthropic-compatible as the provider kind",
        }),
        anthropic_compatible: zCompatibleProviderConfig,
        credentials: apiKeyCredentialsSchema,
      }),
    ],
    { error: "Select a supported provider kind" }
  )
  .superRefine((value, ctx) => {
    if (value.kind === "Azure") {
      if (value.azure.resource_type === "Foundry" && !value.azure.project) {
        ctx.addIssue({
          code: "custom",
          path: ["azure", "project"],
          message: "Foundry project is required for Azure AI Foundry",
        })
      }
      if (value.azure.resource_type === "OpenAI" && value.azure.project) {
        ctx.addIssue({
          code: "custom",
          path: ["azure", "project"],
          message: "Foundry project is only valid for Azure AI Foundry",
        })
      }
    }
    const isOpenAICompatible = value.kind === "OpenAICompatible"
    const isAnthropicCompatible = value.kind === "AnthropicCompatible"
    if (!isOpenAICompatible && !isAnthropicCompatible) {
      return
    }
    const field = isOpenAICompatible ? "openai_compatible" : "anthropic_compatible"
    const config = isOpenAICompatible ? value.openai_compatible : value.anthropic_compatible
    if (config.path && config.path_prefix) {
      ctx.addIssue({
        code: "custom",
        path: [field, "path_prefix"],
        message: "Use either path or path prefix, not both",
      })
    }
    if (config.auth_mode === "APIKey" && !config.auth_header) {
      ctx.addIssue({
        code: "custom",
        path: [field, "auth_header"],
        message: "Authentication header is required for API-key authentication",
      })
    }
    if (config.auth_header && gatewayControlledHeaders.has(config.auth_header)) {
      ctx.addIssue({
        code: "custom",
        path: [field, "auth_header"],
        message: "Authentication header is controlled by the gateway",
      })
    }
    if (config.auth_mode === "None" && (config.auth_header || config.auth_prefix)) {
      ctx.addIssue({
        code: "custom",
        path: [field, "auth_mode"],
        message: "Authentication header and prefix require API-key authentication",
      })
    }
    const names = new Set<string>()
    for (const [index, header] of (config.headers ?? []).entries()) {
      if (names.has(header.name)) {
        ctx.addIssue({
          code: "custom",
          path: [field, "headers", index, "name"],
          message: "Header name must be unique",
        })
      }
      names.add(header.name)
      if (gatewayControlledHeaders.has(header.name) || credentialHeaders.has(header.name)) {
        ctx.addIssue({
          code: "custom",
          path: [field, "headers", index, "name"],
          message: "Static header is controlled by the gateway",
        })
      }
      if (header.name === config.auth_header) {
        ctx.addIssue({
          code: "custom",
          path: [field, "headers", index, "name"],
          message: "Static header must not conflict with the authentication header",
        })
      }
    }
  })

/**
 * ProviderSheet hosts the create/edit form for an inference provider. The
 * sheet keeps a fixed header and footer so the primary action stays visible
 * while the long form scrolls, and it guards against accidental dismissal
 * when the form has unsaved changes.
 */
export function ProviderSheet({
  provider,
  open,
  onOpenChange,
}: {
  provider?: InferenceProvider
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const defaults = provider
    ? zCreateInferenceProviderRequestWritable.parse({
        ...provider,
        credentials: {},
      })
    : ({
        display_name: "",
        catalog_provider: "openai",
        kind: "OpenAI",
        openai: {},
        models: [],
        credentials: {},
      } satisfies CreateInferenceProviderRequestWritable)
  const formSchema = React.useMemo(
    () =>
      providerFormSchema.superRefine((values, ctx) => {
        const isCreate = provider === undefined
        if (values.kind === "OpenAI" || values.kind === "Anthropic" || values.kind === "Gemini") {
          if (isCreate && !values.credentials.api_key?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "api_key"],
              message: "API key is required when creating this provider",
            })
          }
          return
        }
        if (values.kind === "VertexAI") {
          const document = values.credentials.service_account_json
          if (!document?.trim()) {
            if (isCreate) {
              ctx.addIssue({
                code: "custom",
                path: ["credentials", "service_account_json"],
                message: "Service account JSON is required when creating Vertex AI",
              })
            }
            return
          }
          let json: unknown
          try {
            json = JSON.parse(document)
          } catch {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "service_account_json"],
              message: "Service account JSON must be valid JSON",
            })
            return
          }
          if (!serviceAccountDocumentSchema.safeParse(json).success) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "service_account_json"],
              message:
                "Service account JSON must include type, project_id, private_key, client_email, and token_uri",
            })
          }
          return
        }
        if (values.kind === "Bedrock") {
          const authChanged =
            provider?.kind === "Bedrock" && provider.bedrock.auth_mode !== values.bedrock.auth_mode
          if (values.bedrock.auth_mode === "BearerToken") {
            if ((isCreate || authChanged) && !values.credentials.bearer_token?.trim()) {
              ctx.addIssue({
                code: "custom",
                path: ["credentials", "bearer_token"],
                message: "Bearer token is required for bearer-token authentication",
              })
            }
            return
          }
          const hasAccessKey = Boolean(values.credentials.access_key?.trim())
          const hasSecretKey = Boolean(values.credentials.secret_key?.trim())
          if ((isCreate || authChanged || hasSecretKey) && !hasAccessKey) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "access_key"],
              message: "Access key is required with the secret key",
            })
          }
          if ((isCreate || authChanged || hasAccessKey) && !hasSecretKey) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "secret_key"],
              message: "Secret key is required with the access key",
            })
          }
          return
        }
        if (values.kind === "Azure") {
          const authChanged =
            provider?.kind === "Azure" && provider.azure.auth_mode !== values.azure.auth_mode
          if (values.azure.auth_mode === "APIKey") {
            if ((isCreate || authChanged) && !values.credentials.api_key?.trim()) {
              ctx.addIssue({
                code: "custom",
                path: ["credentials", "api_key"],
                message: "API key is required for Azure API-key authentication",
              })
            }
            return
          }
          const credentials = values.credentials
          const hasAny = Boolean(
            credentials.client_id?.trim() ||
            credentials.tenant_id?.trim() ||
            credentials.client_secret?.trim()
          )
          const needsAll = isCreate || authChanged || hasAny
          if (needsAll && !credentials.client_id?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "client_id"],
              message: "Client ID is required for service-principal authentication",
            })
          }
          if (needsAll && !credentials.tenant_id?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "tenant_id"],
              message: "Tenant ID is required for service-principal authentication",
            })
          }
          if (needsAll && !credentials.client_secret?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "client_secret"],
              message: "Client secret is required for service-principal authentication",
            })
          }
          return
        }
        const config =
          values.kind === "OpenAICompatible"
            ? values.openai_compatible
            : values.anthropic_compatible
        const currentAuthMode =
          provider?.kind === "OpenAICompatible"
            ? provider.openai_compatible.auth_mode
            : provider?.kind === "AnthropicCompatible"
              ? provider.anthropic_compatible.auth_mode
              : undefined
        const authEnabled = config.auth_mode === "APIKey"
        const authChanged = currentAuthMode !== undefined && currentAuthMode !== config.auth_mode
        if (authEnabled && (isCreate || authChanged) && !values.credentials.api_key?.trim()) {
          ctx.addIssue({
            code: "custom",
            path: ["credentials", "api_key"],
            message: "API key is required when enabling API-key authentication",
          })
        }
      }),
    [provider]
  )
  const form = useForm<CreateInferenceProviderRequestWritable>({
    defaultValues: defaults,
    resolver: zodResolver(formSchema),
  })
  const models = useFieldArray({ control: form.control, name: "models", keyName: "key" })
  const kind = useWatch({ control: form.control, name: "kind", defaultValue: defaults.kind })
  const compatibleField =
    kind === "AnthropicCompatible" ? "anthropic_compatible" : "openai_compatible"
  const isCompatibleKind = kind === "OpenAICompatible" || kind === "AnthropicCompatible"
  const headers = useFieldArray({
    control: form.control,
    name: `${compatibleField}.headers`,
    keyName: "key",
  })
  const catalogProvider = useWatch({
    control: form.control,
    name: "catalog_provider",
    defaultValue: defaults.catalog_provider,
  })
  const azureResourceType = useWatch({ control: form.control, name: "azure.resource_type" })
  const azureAuthMode = useWatch({ control: form.control, name: "azure.auth_mode" })
  const customAuthMode = useWatch({
    control: form.control,
    name: `${compatibleField}.auth_mode`,
  })
  const bedrockAuthMode = useWatch({ control: form.control, name: "bedrock.auth_mode" })
  const [catalog, setCatalog] = React.useState<InferenceProviderCatalogEntry[]>([])
  const [providerPickerOpen, setProviderPickerOpen] = React.useState(false)
  const [providerCatalogState, setProviderCatalogState] = React.useState<
    "idle" | "loading" | "error"
  >("loading")
  const [suggestions, setSuggestions] = React.useState<InferenceModel[]>([])
  const [modelCatalogState, setModelCatalogState] = React.useState<"idle" | "loading" | "error">(
    "loading"
  )
  const [editingModel, setEditingModel] = React.useState<number>()
  const [submitError, setSubmitError] = React.useState("")
  const [submitErrors, setSubmitErrors] = React.useState<string[]>([])
  const [impact, setImpact] = React.useState<{
    values: CreateInferenceProviderRequestWritable
    pools: string[]
    sandboxes: string[]
  }>()
  const [pending, startTransition] = React.useTransition()

  React.useEffect(() => {
    if (!open) {
      return
    }

    let ignore = false
    void listInferenceProviderCatalogAction().then((result) => {
      if (ignore) {
        return
      }
      if (result.error) {
        setProviderCatalogState("error")
        return
      }
      setCatalog(result.data.providers)
      setProviderCatalogState("idle")
    })

    return () => {
      ignore = true
    }
  }, [open])

  React.useEffect(() => {
    if (!open || !catalogProvider) {
      return
    }

    let ignore = false
    void suggestInferenceModelsAction(catalogProvider, kind).then((result) => {
      if (ignore) {
        return
      }
      if (result.error) {
        setModelCatalogState("error")
        return
      }
      setSuggestions(result.data.models)
      setModelCatalogState("idle")
    })

    return () => {
      ignore = true
    }
  }, [catalogProvider, kind, open])

  const selectedCatalogEntry = catalog.find(
    (entry) => entry.provider_id === catalogProvider && entry.provider_kind === kind
  )

  function save(values: CreateInferenceProviderRequestWritable) {
    setSubmitError("")
    setSubmitErrors([])
    startTransition(async () => {
      const result = provider
        ? await saveInferenceProviderAction({
            providerName: provider.id,
            body: {
              provider: values,
              resource_version: provider.resource_version,
            },
          })
        : await saveInferenceProviderAction({ body: values })
      if (result.error) {
        setSubmitError(result.error.message)
        setSubmitErrors(
          result.error.errors?.map((error) => `${error.field}: ${error.message}`) ?? []
        )
        return
      }
      toast.success(provider ? "Inference provider updated" : "Inference provider created")
      form.reset()
      onOpenChange(false)
    })
  }

  function handleSubmit(values: CreateInferenceProviderRequestWritable) {
    if (!provider) {
      save(values)
      return
    }

    const current = new Map(provider.models.map((model) => [model.id, model]))
    const changed =
      provider.models.length !== values.models.length ||
      values.models.some((model) => {
        const prior = current.get(model.id)
        return (
          !prior ||
          JSON.stringify(prior.capabilities) !== JSON.stringify(model.capabilities) ||
          JSON.stringify(prior.modalities) !== JSON.stringify(model.modalities) ||
          JSON.stringify(prior.limits) !== JSON.stringify(model.limits)
        )
      })
    if (!changed) {
      save(values)
      return
    }

    startTransition(async () => {
      const result = await getInferenceProviderUsageAction(provider.id)
      if (result.error) {
        setSubmitError(result.error.message)
        return
      }
      if (!result.usage || result.usage.pools.length === 0) {
        save(values)
        return
      }
      setImpact({
        values,
        pools: result.usage.pools,
        sandboxes: result.usage.sandboxes,
      })
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            {provider ? (
              <ProviderIcon provider={provider.catalog_provider} className="size-4" />
            ) : null}
            {provider ? "Edit inference provider" : "Add inference provider"}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {provider ? "Edit inference provider" : "Add inference provider"}
          </SheetDescription>
          {provider ? (
            <div className="text-muted-foreground flex items-center gap-1 pt-1 text-xs">
              <code className="font-mono">{provider.id}</code>
              <CopyButton content={provider.id} />
            </div>
          ) : null}
        </SheetHeader>

        <form
          id="inference-provider-form"
          className="flex flex-1 flex-col gap-5 px-4 pb-2"
          onSubmit={form.handleSubmit(handleSubmit, () =>
            setSubmitError("Provider configuration is invalid")
          )}
        >
          <FieldGroup>
            <FormSection icon={Tag} title="Identity">
              <Field data-invalid={Boolean(form.formState.errors.display_name)}>
                <FieldLabel htmlFor="provider-display-name" required>
                  Display name
                </FieldLabel>
                <Input
                  id="provider-display-name"
                  placeholder="Production OpenAI"
                  autoComplete="off"
                  {...form.register("display_name")}
                />
                <FieldError errors={[form.formState.errors.display_name]} />
              </Field>
              <Field data-invalid={Boolean(form.formState.errors.catalog_provider)}>
                <FieldLabel required>Provider</FieldLabel>
                <Controller
                  control={form.control}
                  name="catalog_provider"
                  render={({ field }) => (
                    <Popover open={providerPickerOpen} onOpenChange={setProviderPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-expanded={providerPickerOpen}
                          disabled={Boolean(provider) || providerCatalogState === "loading"}
                          className="w-full justify-between font-normal"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <ProviderIcon provider={catalogProvider} className="size-4 shrink-0" />
                            <span className="truncate">
                              {selectedCatalogEntry?.name ?? provider?.display_name ?? field.value}
                            </span>
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {providerKindLabels[kind]}
                            </span>
                          </span>
                          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-(--radix-popover-trigger-width) p-0"
                      >
                        <Command>
                          <CommandInput placeholder="Search 156 providers…" />
                          <CommandList>
                            <CommandEmpty>No provider found.</CommandEmpty>
                            <CommandGroup>
                              {catalog.map((entry) => (
                                <CommandItem
                                  key={`${entry.provider_id}:${entry.provider_kind}`}
                                  value={`${entry.name} ${entry.provider_id} ${providerKindLabels[entry.provider_kind]}`}
                                  onSelect={() => {
                                    setModelCatalogState("loading")
                                    const common = {
                                      catalog_provider: entry.provider_id,
                                      display_name: entry.name,
                                      models: [],
                                      credentials: {},
                                    }
                                    switch (entry.provider_kind) {
                                      case "OpenAI":
                                        form.reset({
                                          ...common,
                                          kind: "OpenAI",
                                          openai: { base_url: entry.base_url },
                                        })
                                        break
                                      case "Anthropic":
                                        form.reset({
                                          ...common,
                                          kind: "Anthropic",
                                          anthropic: { base_url: entry.base_url },
                                        })
                                        break
                                      case "Gemini":
                                        form.reset({
                                          ...common,
                                          kind: "Gemini",
                                          gemini: { base_url: entry.base_url },
                                        })
                                        break
                                      case "VertexAI":
                                        form.reset({
                                          ...common,
                                          kind: "VertexAI",
                                          vertex_ai: { project: "", region: "" },
                                        })
                                        break
                                      case "Bedrock":
                                        form.reset({
                                          ...common,
                                          kind: "Bedrock",
                                          bedrock: { region: "us-east-1", auth_mode: "AccessKey" },
                                        })
                                        break
                                      case "Azure":
                                        form.reset({
                                          ...common,
                                          kind: "Azure",
                                          azure: {
                                            resource_type: "OpenAI",
                                            resource_name: "",
                                            api_version: "2025-04-01-preview",
                                            auth_mode: "APIKey",
                                          },
                                        })
                                        break
                                      case "OpenAICompatible":
                                        form.reset({
                                          ...common,
                                          kind: "OpenAICompatible",
                                          openai_compatible: {
                                            base_url: entry.base_url ?? "",
                                            auth_mode: "APIKey",
                                            auth_header: entry.auth_header ?? "authorization",
                                            auth_prefix: entry.auth_prefix,
                                          },
                                        })
                                        break
                                      case "AnthropicCompatible":
                                        form.reset({
                                          ...common,
                                          kind: "AnthropicCompatible",
                                          anthropic_compatible: {
                                            base_url: entry.base_url ?? "",
                                            auth_mode: "APIKey",
                                            auth_header: entry.auth_header ?? "x-api-key",
                                            auth_prefix: entry.auth_prefix,
                                          },
                                        })
                                        break
                                    }
                                    setProviderPickerOpen(false)
                                  }}
                                >
                                  <ProviderIcon provider={entry.provider_id} className="size-4" />
                                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                  <span className="text-muted-foreground text-xs">
                                    {providerKindLabels[entry.provider_kind]}
                                  </span>
                                  <Check
                                    className={cn(
                                      "size-4",
                                      entry.provider_id === catalogProvider &&
                                        entry.provider_kind === kind
                                        ? "opacity-100"
                                        : "opacity-0"
                                    )}
                                  />
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  )}
                />
                <FieldError
                  errors={[form.formState.errors.catalog_provider, form.formState.errors.kind]}
                />
                {providerCatalogState === "error" ? (
                  <FieldDescription>
                    Provider catalog is unavailable. Reopen the form to retry.
                  </FieldDescription>
                ) : null}
                {provider ? (
                  <FieldDescription>
                    The provider and kind cannot be changed after creation.
                  </FieldDescription>
                ) : null}
              </Field>
            </FormSection>

            <FormSection icon={Cable} title="Connection">
              {kind === "VertexAI" && (
                <>
                  <Field>
                    <FieldLabel required>Project</FieldLabel>
                    <Input autoComplete="off" {...form.register("vertex_ai.project")} />
                    <FieldError errors={[form.getFieldState("vertex_ai.project").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Region</FieldLabel>
                    <Input
                      placeholder="us-central1"
                      autoComplete="off"
                      {...form.register("vertex_ai.region")}
                    />
                    <FieldError errors={[form.getFieldState("vertex_ai.region").error]} />
                  </Field>
                </>
              )}
              {kind === "Bedrock" && (
                <>
                  <Field>
                    <FieldLabel required>Region</FieldLabel>
                    <Input
                      placeholder="us-east-1"
                      autoComplete="off"
                      {...form.register("bedrock.region")}
                    />
                    <FieldError errors={[form.getFieldState("bedrock.region").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Authentication</FieldLabel>
                    <Controller
                      control={form.control}
                      name="bedrock.auth_mode"
                      defaultValue="AccessKey"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            form.setValue(
                              "credentials",
                              {},
                              {
                                shouldDirty: true,
                                shouldValidate: true,
                              }
                            )
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="AccessKey">AWS access keys</SelectItem>
                            <SelectItem value="BearerToken">Bedrock API key</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError errors={[form.getFieldState("bedrock.auth_mode").error]} />
                  </Field>
                </>
              )}
              {kind === "Azure" && (
                <>
                  <Field>
                    <FieldLabel required>Resource type</FieldLabel>
                    <Controller
                      control={form.control}
                      name="azure.resource_type"
                      defaultValue="OpenAI"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            if (value === "OpenAI") {
                              form.setValue("azure.project", undefined, {
                                shouldDirty: true,
                                shouldValidate: true,
                              })
                            }
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="OpenAI">Azure OpenAI</SelectItem>
                            <SelectItem value="Foundry">Azure AI Foundry</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError errors={[form.getFieldState("azure.resource_type").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Resource name</FieldLabel>
                    <Input autoComplete="off" {...form.register("azure.resource_name")} />
                    <FieldError errors={[form.getFieldState("azure.resource_name").error]} />
                  </Field>
                  {azureResourceType === "Foundry" && (
                    <Field>
                      <FieldLabel required>Foundry project</FieldLabel>
                      <Input autoComplete="off" {...form.register("azure.project")} />
                      <FieldError errors={[form.getFieldState("azure.project").error]} />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel required>API version</FieldLabel>
                    <Input
                      placeholder="2025-04-01-preview"
                      autoComplete="off"
                      {...form.register("azure.api_version")}
                    />
                    <FieldError errors={[form.getFieldState("azure.api_version").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Authentication</FieldLabel>
                    <Controller
                      control={form.control}
                      name="azure.auth_mode"
                      defaultValue="APIKey"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            form.setValue(
                              "credentials",
                              {},
                              {
                                shouldDirty: true,
                                shouldValidate: true,
                              }
                            )
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="APIKey">API key</SelectItem>
                            <SelectItem value="ServicePrincipal">Service principal</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError errors={[form.getFieldState("azure.auth_mode").error]} />
                  </Field>
                </>
              )}
              {isCompatibleKind && (
                <>
                  <Field>
                    <FieldLabel required>Base URL</FieldLabel>
                    <Input
                      type="url"
                      placeholder={
                        selectedCatalogEntry?.base_url_template ?? "https://api.example.com"
                      }
                      autoComplete="off"
                      spellCheck={false}
                      {...form.register(`${compatibleField}.base_url`)}
                    />
                    <FieldError
                      errors={[form.getFieldState(`${compatibleField}.base_url`).error]}
                    />
                    {selectedCatalogEntry?.base_url_template ? (
                      <FieldDescription>
                        Replace the placeholders in {selectedCatalogEntry.base_url_template}.
                      </FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel required>Authentication</FieldLabel>
                    <Controller
                      control={form.control}
                      name={`${compatibleField}.auth_mode`}
                      defaultValue="APIKey"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            form.setValue(
                              "credentials",
                              {},
                              {
                                shouldDirty: true,
                                shouldValidate: true,
                              }
                            )
                            form.setValue(
                              `${compatibleField}.auth_header`,
                              value === "APIKey" ? "authorization" : undefined,
                              { shouldDirty: true, shouldValidate: true }
                            )
                            form.setValue(`${compatibleField}.auth_prefix`, undefined, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="APIKey">API key</SelectItem>
                            <SelectItem value="None">No authentication</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError
                      errors={[form.getFieldState(`${compatibleField}.auth_mode`).error]}
                    />
                  </Field>
                </>
              )}
              {(kind === "OpenAI" ||
                kind === "Anthropic" ||
                kind === "Gemini" ||
                isCompatibleKind) && (
                <Accordion type="single" collapsible className="rounded-lg border">
                  <AccordionItem value="advanced" className="border-none">
                    <AccordionTrigger className="focus-visible:bg-muted/60 px-4 py-3 hover:no-underline focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:rounded-b-none">
                      Advanced
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pt-1 pb-4 [&>div]:h-auto">
                      <FieldGroup>
                        {kind === "OpenAI" && (
                          <Field>
                            <FieldLabel>Base URL override</FieldLabel>
                            <Input
                              type="url"
                              spellCheck={false}
                              {...form.register("openai.base_url", {
                                setValueAs: (value) => value || undefined,
                              })}
                            />
                            <FieldError errors={[form.getFieldState("openai.base_url").error]} />
                          </Field>
                        )}
                        {kind === "Anthropic" && (
                          <Field>
                            <FieldLabel>Base URL override</FieldLabel>
                            <Input
                              type="url"
                              spellCheck={false}
                              {...form.register("anthropic.base_url", {
                                setValueAs: (value) => value || undefined,
                              })}
                            />
                            <FieldError errors={[form.getFieldState("anthropic.base_url").error]} />
                          </Field>
                        )}
                        {kind === "Gemini" && (
                          <Field>
                            <FieldLabel>Base URL override</FieldLabel>
                            <Input
                              type="url"
                              spellCheck={false}
                              {...form.register("gemini.base_url", {
                                setValueAs: (value) => value || undefined,
                              })}
                            />
                            <FieldError errors={[form.getFieldState("gemini.base_url").error]} />
                          </Field>
                        )}
                        {isCompatibleKind && (
                          <>
                            <Field>
                              <FieldLabel>Path</FieldLabel>
                              <Input
                                placeholder="/v1/chat/completions"
                                spellCheck={false}
                                {...form.register(`${compatibleField}.path`, {
                                  setValueAs: (value) => value || undefined,
                                })}
                              />
                              <FieldError
                                errors={[form.getFieldState(`${compatibleField}.path`).error]}
                              />
                            </Field>
                            <Field>
                              <FieldLabel>Path prefix</FieldLabel>
                              <Input
                                placeholder="/v1"
                                spellCheck={false}
                                {...form.register(`${compatibleField}.path_prefix`, {
                                  setValueAs: (value) => value || undefined,
                                })}
                              />
                              <FieldError
                                errors={[
                                  form.getFieldState(`${compatibleField}.path_prefix`).error,
                                ]}
                              />
                            </Field>
                            {customAuthMode === "APIKey" && (
                              <>
                                <Field>
                                  <FieldLabel required>Authentication header</FieldLabel>
                                  <Input
                                    defaultValue="authorization"
                                    placeholder="authorization"
                                    spellCheck={false}
                                    {...form.register(`${compatibleField}.auth_header`)}
                                  />
                                  <FieldError
                                    errors={[
                                      form.getFieldState(`${compatibleField}.auth_header`).error,
                                    ]}
                                  />
                                </Field>
                                <Field>
                                  <FieldLabel>Authentication prefix</FieldLabel>
                                  <Input
                                    placeholder="Bearer "
                                    spellCheck={false}
                                    {...form.register(`${compatibleField}.auth_prefix`)}
                                  />
                                  <FieldError
                                    errors={[
                                      form.getFieldState(`${compatibleField}.auth_prefix`).error,
                                    ]}
                                  />
                                </Field>
                              </>
                            )}
                            <Field>
                              <FieldLabel>Static headers</FieldLabel>
                              <FieldDescription>Non-secret headers only.</FieldDescription>
                              <div className="space-y-2">
                                {headers.fields.map((header, index) => (
                                  <div
                                    key={header.key}
                                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
                                  >
                                    <Input
                                      aria-label={`Header ${index + 1} name`}
                                      placeholder="x-tenant"
                                      spellCheck={false}
                                      {...form.register(`${compatibleField}.headers.${index}.name`)}
                                    />
                                    <Input
                                      aria-label={`Header ${index + 1} value`}
                                      placeholder="public-value"
                                      {...form.register(
                                        `${compatibleField}.headers.${index}.value`
                                      )}
                                    />
                                    <Button
                                      type="button"
                                      variant="destructive"
                                      size="icon-sm"
                                      aria-label={`Remove header ${index + 1}`}
                                      onClick={() => headers.remove(index)}
                                    >
                                      <Trash2 />
                                    </Button>
                                    <FieldError
                                      className="col-span-full"
                                      errors={[
                                        form.getFieldState(
                                          `${compatibleField}.headers.${index}.name`
                                        ).error,
                                        form.getFieldState(
                                          `${compatibleField}.headers.${index}.value`
                                        ).error,
                                      ]}
                                    />
                                  </div>
                                ))}
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => headers.append({ name: "", value: "" })}
                                >
                                  <Plus /> Add header
                                </Button>
                                <FieldError
                                  errors={[form.getFieldState(`${compatibleField}.headers`).error]}
                                />
                              </div>
                            </Field>
                            <Controller
                              control={form.control}
                              name={`${compatibleField}.allow_private_endpoint`}
                              defaultValue={false}
                              render={({ field }) => (
                                <Field orientation="horizontal">
                                  <div>
                                    <FieldLabel>Allow private endpoints</FieldLabel>
                                    <FieldDescription>
                                      Permits connections to private network addresses.
                                    </FieldDescription>
                                  </div>
                                  <Switch
                                    checked={field.value ?? false}
                                    onCheckedChange={field.onChange}
                                  />
                                </Field>
                              )}
                            />
                            <FieldError
                              errors={[
                                form.getFieldState(`${compatibleField}.allow_private_endpoint`)
                                  .error,
                              ]}
                            />
                            <Controller
                              control={form.control}
                              name={`${compatibleField}.skip_tls_verify`}
                              defaultValue={false}
                              render={({ field }) => (
                                <Field orientation="horizontal">
                                  <div>
                                    <FieldLabel>Skip TLS verification</FieldLabel>
                                    <FieldDescription>
                                      Accepts an unverified HTTPS certificate.
                                    </FieldDescription>
                                  </div>
                                  <Switch
                                    checked={field.value ?? false}
                                    onCheckedChange={field.onChange}
                                  />
                                </Field>
                              )}
                            />
                            <FieldError
                              errors={[
                                form.getFieldState(`${compatibleField}.skip_tls_verify`).error,
                              ]}
                            />
                          </>
                        )}
                      </FieldGroup>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </FormSection>

            <FormSection
              icon={KeyRound}
              title="Credentials"
              description={provider ? "Leave blank to keep the current credentials." : undefined}
            >
              {(kind === "OpenAI" ||
                kind === "Anthropic" ||
                kind === "Gemini" ||
                (isCompatibleKind && customAuthMode === "APIKey") ||
                (kind === "Azure" && azureAuthMode === "APIKey")) && (
                <Field>
                  <FieldLabel required={!provider}>API key</FieldLabel>
                  <Input
                    type="password"
                    spellCheck={false}
                    autoComplete="new-password"
                    {...form.register("credentials.api_key")}
                  />
                  <FieldError errors={[form.getFieldState("credentials.api_key").error]} />
                </Field>
              )}
              {kind === "VertexAI" && (
                <Field>
                  <FieldLabel required={!provider}>Service account JSON</FieldLabel>
                  <ServiceAccountJsonField
                    onChange={(value) =>
                      form.setValue("credentials.service_account_json", value, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    register={form.register("credentials.service_account_json")}
                  />
                  <FieldError
                    errors={[form.getFieldState("credentials.service_account_json").error]}
                  />
                </Field>
              )}
              {kind === "Bedrock" && bedrockAuthMode === "AccessKey" && (
                <>
                  <Field>
                    <FieldLabel required={!provider}>Access key</FieldLabel>
                    <Input
                      type="password"
                      spellCheck={false}
                      autoComplete="new-password"
                      {...form.register("credentials.access_key")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.access_key").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required={!provider}>Secret key</FieldLabel>
                    <Input
                      type="password"
                      spellCheck={false}
                      autoComplete="new-password"
                      {...form.register("credentials.secret_key")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.secret_key").error]} />
                  </Field>
                  <Field>
                    <FieldLabel>Session token</FieldLabel>
                    <Input
                      type="password"
                      spellCheck={false}
                      autoComplete="new-password"
                      {...form.register("credentials.session_token")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.session_token").error]} />
                  </Field>
                </>
              )}
              {kind === "Bedrock" && bedrockAuthMode === "BearerToken" && (
                <Field>
                  <FieldLabel required={!provider}>Bedrock API key</FieldLabel>
                  <Input
                    type="password"
                    spellCheck={false}
                    autoComplete="new-password"
                    {...form.register("credentials.bearer_token")}
                  />
                  <FieldError errors={[form.getFieldState("credentials.bearer_token").error]} />
                </Field>
              )}
              {kind === "Azure" && azureAuthMode === "ServicePrincipal" && (
                <>
                  <Field>
                    <FieldLabel required={!provider}>Client ID</FieldLabel>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      {...form.register("credentials.client_id")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.client_id").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required={!provider}>Tenant ID</FieldLabel>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      {...form.register("credentials.tenant_id")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.tenant_id").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required={!provider}>Client secret</FieldLabel>
                    <Input
                      type="password"
                      spellCheck={false}
                      autoComplete="new-password"
                      {...form.register("credentials.client_secret")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.client_secret").error]} />
                  </Field>
                </>
              )}
              {isCompatibleKind && customAuthMode === "None" && (
                <p className="text-muted-foreground text-sm">No credentials required.</p>
              )}
            </FormSection>

            <FormSection icon={Brain} title="Models">
              <Field data-invalid={Boolean(form.formState.errors.models)}>
                <FieldLabel htmlFor="provider-models" required>
                  Models
                </FieldLabel>
                <MultiSelectDropdown
                  allowCustomValues
                  id="provider-models"
                  invalid={Boolean(form.formState.errors.models)}
                  options={[
                    ...new Map(
                      [...models.fields, ...suggestions].map((model) => [
                        model.id,
                        {
                          label:
                            model.display_name === model.id
                              ? model.id
                              : `${model.display_name} (${model.id})`,
                          value: model.id,
                        },
                      ])
                    ).values(),
                  ]}
                  placeholder="Select models"
                  searchPlaceholder="Search or enter a model ID…"
                  emptyMessage="No catalog models found. Enter a model ID."
                  value={models.fields.map((model) => model.id)}
                  onValueChangeAction={(modelIDs) => {
                    const current = form.getValues("models")
                    models.replace(
                      modelIDs.map(
                        (modelID) =>
                          current.find((model) => model.id === modelID) ??
                          suggestions.find((model) => model.id === modelID) ?? {
                            ...blankModel,
                            id: modelID,
                            display_name: modelID,
                          }
                      )
                    )
                  }}
                />
                <FieldError errors={[form.formState.errors.models]} />
              </Field>
              {modelCatalogState === "loading" && (
                <p
                  aria-live="polite"
                  className="text-muted-foreground flex items-center gap-2 text-sm"
                >
                  <Spinner />
                  Loading model catalog…
                </p>
              )}
              {modelCatalogState === "error" && (
                <Alert variant="warning">
                  <TriangleAlert />
                  <AlertTitle>Model catalog unavailable</AlertTitle>
                  <AlertDescription>You can still enter model IDs manually.</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                {models.fields.map((model, index) => (
                  <div
                    key={model.key}
                    className="hover:bg-muted/50 flex items-center gap-1 rounded-md px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{model.display_name}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        <span className="font-mono">{model.id}</span>
                        <span aria-hidden> · </span>
                        <span className="tabular-nums">
                          {formatCompactNumber(model.limits.context)} context
                        </span>
                      </div>
                      <FieldError
                        errors={[
                          form.getFieldState(`models.${index}.id`).error,
                          form.getFieldState(`models.${index}.display_name`).error,
                        ]}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${model.display_name} metadata`}
                      onClick={() => setEditingModel(index)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-sm"
                      aria-label={`Remove ${model.display_name}`}
                      onClick={() => models.remove(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                {models.fields.length === 0 && (
                  <p className="text-muted-foreground px-2 py-1.5 text-sm">
                    At least one model is required.
                  </p>
                )}
              </div>
            </FormSection>
          </FieldGroup>

          <div className="space-y-3">
            {submitError && (
              <Alert variant="destructive" className="max-h-32 overflow-y-auto">
                <CircleAlert />
                <AlertTitle>{submitError}</AlertTitle>
                {submitErrors.length > 0 && (
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {submitErrors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                )}
              </Alert>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}
                {provider ? "Save changes" : "Add provider"}
              </Button>
            </div>
          </div>
        </form>

        <ModelMetadataDialog
          form={form}
          editingModel={editingModel}
          onCloseAction={() => setEditingModel(undefined)}
        />
        <Dialog open={Boolean(impact)} onOpenChange={(next) => !next && setImpact(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Update shared Pool contracts?</DialogTitle>
              <DialogDescription>
                Model capabilities, modalities, or limits changed. Saving recalculates every
                dependent Pool and regenerates configuration for affected Sandboxes and Agents.
              </DialogDescription>
            </DialogHeader>
            {impact ? (
              <div className="space-y-4 text-sm">
                <div>
                  <p className="font-medium">Pools</p>
                  <p className="text-muted-foreground">{impact.pools.join(", ")}</p>
                </div>
                <div>
                  <p className="font-medium">Sandboxes</p>
                  <p className="text-muted-foreground">
                    {impact.sandboxes.length ? impact.sandboxes.join(", ") : "None"}
                  </p>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setImpact(undefined)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!impact) return
                  const values = impact.values
                  setImpact(undefined)
                  save(values)
                }}
              >
                Update provider
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}

/** FormSection renders a titled, iconed block of related fields. */
function FormSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm leading-5 font-medium">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

/**
 * ServiceAccountJsonField pairs the JSON textarea with a hidden file input so
 * operators can import the document instead of pasting it.
 */
function ServiceAccountJsonField({
  register,
  onChange,
}: {
  onChange: (value: string) => void
  register: UseFormRegisterReturn
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-2">
      <Textarea className="min-h-36 font-mono text-xs" spellCheck={false} {...register} />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Import service account JSON"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file) return
          void file.text().then(onChange)
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
        <Upload />
        Import JSON file
      </Button>
    </div>
  )
}

/**
 * ModelMetadataDialog edits one model's display name, limits, capabilities,
 * and modalities. Values configure OpenCode capabilities and request limits.
 */
function ModelMetadataDialog({
  form,
  editingModel,
  onCloseAction,
}: {
  form: ReturnType<typeof useForm<CreateInferenceProviderRequestWritable>>
  editingModel?: number
  onCloseAction: () => void
}) {
  return (
    <Dialog
      open={editingModel !== undefined}
      onOpenChange={(value) => {
        if (!value) onCloseAction()
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Model metadata</DialogTitle>
          <DialogDescription>
            These values configure OpenCode capabilities and request limits.
          </DialogDescription>
        </DialogHeader>
        {editingModel !== undefined && (
          <div className="space-y-4">
            <Field>
              <FieldLabel required>Display name</FieldLabel>
              <Input {...form.register(`models.${editingModel}.display_name`)} />
              <FieldError
                errors={[form.getFieldState(`models.${editingModel}.display_name`).error]}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel required>Context</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  {...form.register(`models.${editingModel}.limits.context`, {
                    valueAsNumber: true,
                  })}
                />
                <FieldError
                  errors={[form.getFieldState(`models.${editingModel}.limits.context`).error]}
                />
              </Field>
              <Field>
                <FieldLabel>Max input</FieldLabel>
                <Controller
                  control={form.control}
                  name={`models.${editingModel}.limits.input`}
                  render={({ field }) => (
                    <Input
                      type="number"
                      min={0}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={(event) =>
                        field.onChange(
                          event.target.value === "" ? undefined : event.target.valueAsNumber
                        )
                      }
                    />
                  )}
                />
                <FieldError
                  errors={[form.getFieldState(`models.${editingModel}.limits.input`).error]}
                />
              </Field>
              <Field>
                <FieldLabel required>Max output</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  {...form.register(`models.${editingModel}.limits.output`, {
                    valueAsNumber: true,
                  })}
                />
                <FieldError
                  errors={[form.getFieldState(`models.${editingModel}.limits.output`).error]}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Capabilities</FieldLabel>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {capabilities.map((capability) => (
                  <Controller
                    key={capability}
                    control={form.control}
                    name={`models.${editingModel}.capabilities.${capability}`}
                    render={({ field }) => (
                      <label className="hover:bg-muted/50 has-data-checked:border-primary/40 has-data-checked:bg-primary/5 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm capitalize transition-colors">
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                        {capability.replace("_", " ")}
                      </label>
                    )}
                  />
                ))}
              </div>
              <FieldError
                errors={capabilities.map(
                  (capability) =>
                    form.getFieldState(`models.${editingModel}.capabilities.${capability}`).error
                )}
              />
            </Field>
            {(["input", "output"] as const).map((direction) => (
              <Controller
                key={direction}
                control={form.control}
                name={`models.${editingModel}.modalities.${direction}`}
                render={({ field }) => (
                  <Field>
                    <FieldLabel className="capitalize">{direction} modalities</FieldLabel>
                    <div className="grid grid-cols-3 gap-2">
                      {modalities.map((modality) => (
                        <label
                          key={modality}
                          className="hover:bg-muted/50 has-data-checked:border-primary/40 has-data-checked:bg-primary/5 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm capitalize transition-colors"
                        >
                          <Checkbox
                            checked={field.value.includes(modality)}
                            onCheckedChange={(checked) =>
                              field.onChange(
                                checked === true
                                  ? [...field.value, modality]
                                  : field.value.filter((value) => value !== modality)
                              )
                            }
                          />
                          {modality}
                        </label>
                      ))}
                    </div>
                    <FieldError
                      errors={[
                        form.getFieldState(`models.${editingModel}.modalities.${direction}`).error,
                      ]}
                    />
                  </Field>
                )}
              />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={async () => {
              if (editingModel !== undefined && (await form.trigger(`models.${editingModel}`))) {
                onCloseAction()
              }
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
