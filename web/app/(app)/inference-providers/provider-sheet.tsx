"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import {
  Brain,
  Cable,
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
  saveInferenceProviderAction,
  suggestInferenceModelsAction,
} from "@/data/inference-provider.actions"
import { formatCompactNumber } from "@/lib/format"
import {
  type CreateInferenceProviderRequestWritable,
  type InferenceModel,
  type InferenceModelModality,
  type InferenceProvider,
} from "@/lib/gateway/client"
import { zCreateInferenceProviderRequestWritable } from "@/lib/gateway/client/zod.gen"
import { ProviderIcon, providerTypeLabels, providerTypes } from "./provider-shared"

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
    "type",
    [
      z.object({
        ...providerFields,
        type: z.literal("OpenAI", { error: "Select OpenAI as the provider type" }),
        openai: z.object({ base_url: baseURLSchema }),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        type: z.literal("Anthropic", { error: "Select Anthropic as the provider type" }),
        anthropic: z.object({ base_url: baseURLSchema }),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        type: z.literal("Gemini", { error: "Select Gemini as the provider type" }),
        gemini: z.record(z.string(), z.never({ error: "Gemini configuration is invalid" })),
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        type: z.literal("VertexAI", { error: "Select Vertex AI as the provider type" }),
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
        type: z.literal("Bedrock", { error: "Select Bedrock as the provider type" }),
        bedrock: z.object({
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
        }),
      }),
      z.object({
        ...providerFields,
        type: z.literal("Azure", { error: "Select Azure as the provider type" }),
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
        type: z.literal("OpenAICompatible", {
          error: "Select OpenAI-compatible as the provider type",
        }),
        openai_compatible: z.object({
          base_url: z
            .url({ error: "Enter a valid base URL" })
            .max(2048, { error: "Base URL must be at most 2,048 characters" }),
          path: z
            .string({ error: "Path must be text" })
            .max(1024, { error: "Path must be at most 1,024 characters" })
            .regex(/^\/[^?#]*$/, {
              error: "Path must start with / and contain no query or fragment",
            })
            .optional(),
          path_prefix: z
            .string({ error: "Path prefix must be text" })
            .max(1024, { error: "Path prefix must be at most 1,024 characters" })
            .regex(/^\/[^?#]*$/, {
              error: "Path prefix must start with / and contain no query or fragment",
            })
            .optional(),
          auth_mode: z.enum(["None", "APIKey"], {
            error: "Select API key or no authentication",
          }),
          auth_header: z
            .string({ error: "Authentication header is required" })
            .min(1, { error: "Authentication header is required" })
            .max(128, { error: "Authentication header must be at most 128 characters" })
            .regex(/^[a-z0-9!#$%&'*+.^_|~-]+$/, {
              error: "Authentication header must use lowercase HTTP header characters",
            })
            .optional(),
          auth_prefix: z
            .string({ error: "Authentication prefix must be text" })
            .max(128, { error: "Authentication prefix must be at most 128 characters" })
            .refine((value) => !/[\x00-\x08\x0A-\x1F\x7F]/.test(value), {
              error: "Authentication prefix must not contain header control characters",
            })
            .optional(),
          headers: z
            .array(
              z.object({
                name: z
                  .string({ error: "Header name is required" })
                  .min(1, { error: "Header name is required" })
                  .max(128, { error: "Header name must be at most 128 characters" })
                  .regex(/^[a-z0-9!#$%&'*+.^_|~-]+$/, {
                    error: "Header name must use lowercase HTTP header characters",
                  }),
                value: z
                  .string({ error: "Header value is required" })
                  .min(1, { error: "Header value is required" })
                  .max(1024, { error: "Header value must be at most 1,024 characters" })
                  .refine((value) => !/[\x00-\x08\x0A-\x1F\x7F]/.test(value), {
                    error: "Header value must not contain header control characters",
                  }),
              }),
              { error: "Static headers must be a list" }
            )
            .max(32, { error: "Add at most 32 static headers" })
            .optional(),
          allow_private_endpoint: z
            .boolean({
              error: "Private endpoint access must be enabled or disabled",
            })
            .optional(),
          skip_tls_verify: z
            .boolean({ error: "TLS verification must be enabled or disabled" })
            .optional(),
        }),
        credentials: apiKeyCredentialsSchema,
      }),
    ],
    { error: "Select a supported provider type" }
  )
  .superRefine((value, ctx) => {
    if (value.type === "Azure") {
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
    if (value.type !== "OpenAICompatible") {
      return
    }
    const config = value.openai_compatible
    if (config.path && config.path_prefix) {
      ctx.addIssue({
        code: "custom",
        path: ["openai_compatible", "path_prefix"],
        message: "Use either path or path prefix, not both",
      })
    }
    if (config.auth_mode === "APIKey" && !config.auth_header) {
      ctx.addIssue({
        code: "custom",
        path: ["openai_compatible", "auth_header"],
        message: "Authentication header is required for API-key authentication",
      })
    }
    if (config.auth_header && gatewayControlledHeaders.has(config.auth_header)) {
      ctx.addIssue({
        code: "custom",
        path: ["openai_compatible", "auth_header"],
        message: "Authentication header is controlled by the gateway",
      })
    }
    if (config.auth_mode === "None" && (config.auth_header || config.auth_prefix)) {
      ctx.addIssue({
        code: "custom",
        path: ["openai_compatible", "auth_mode"],
        message: "Authentication header and prefix require API-key authentication",
      })
    }
    const names = new Set<string>()
    for (const [index, header] of (config.headers ?? []).entries()) {
      if (names.has(header.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["openai_compatible", "headers", index, "name"],
          message: "Header name must be unique",
        })
      }
      names.add(header.name)
      if (gatewayControlledHeaders.has(header.name) || credentialHeaders.has(header.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["openai_compatible", "headers", index, "name"],
          message: "Static header is controlled by the gateway",
        })
      }
      if (header.name === config.auth_header) {
        ctx.addIssue({
          code: "custom",
          path: ["openai_compatible", "headers", index, "name"],
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
        type: "OpenAI",
        openai: {},
        models: [],
        credentials: {},
      } satisfies CreateInferenceProviderRequestWritable)
  const formSchema = React.useMemo(
    () =>
      providerFormSchema.superRefine((values, ctx) => {
        const isCreate = provider === undefined
        if (values.type === "OpenAI" || values.type === "Anthropic" || values.type === "Gemini") {
          if (isCreate && !values.credentials.api_key?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "api_key"],
              message: "API key is required when creating this provider",
            })
          }
          return
        }
        if (values.type === "VertexAI") {
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
        if (values.type === "Bedrock") {
          const hasAccessKey = Boolean(values.credentials.access_key?.trim())
          const hasSecretKey = Boolean(values.credentials.secret_key?.trim())
          if ((isCreate || hasSecretKey) && !hasAccessKey) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "access_key"],
              message: "Access key is required with the secret key",
            })
          }
          if ((isCreate || hasAccessKey) && !hasSecretKey) {
            ctx.addIssue({
              code: "custom",
              path: ["credentials", "secret_key"],
              message: "Secret key is required with the access key",
            })
          }
          return
        }
        if (values.type === "Azure") {
          const authChanged =
            provider?.type === "Azure" && provider.azure.auth_mode !== values.azure.auth_mode
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
        const authEnabled = values.openai_compatible.auth_mode === "APIKey"
        const authChanged =
          provider?.type === "OpenAICompatible" &&
          provider.openai_compatible.auth_mode !== values.openai_compatible.auth_mode
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
  const headers = useFieldArray({
    control: form.control,
    name: "openai_compatible.headers",
    keyName: "key",
  })
  const type = useWatch({ control: form.control, name: "type", defaultValue: defaults.type })
  const azureResourceType = useWatch({ control: form.control, name: "azure.resource_type" })
  const azureAuthMode = useWatch({ control: form.control, name: "azure.auth_mode" })
  const customAuthMode = useWatch({ control: form.control, name: "openai_compatible.auth_mode" })
  const [suggestions, setSuggestions] = React.useState<InferenceModel[]>([])
  const [catalogState, setCatalogState] = React.useState<"idle" | "loading" | "error">("loading")
  const [editingModel, setEditingModel] = React.useState<number>()
  const [submitError, setSubmitError] = React.useState("")
  const [submitErrors, setSubmitErrors] = React.useState<string[]>([])
  const [pending, startTransition] = React.useTransition()

  React.useEffect(() => {
    if (!open) {
      return
    }

    let ignore = false
    void suggestInferenceModelsAction(type).then((result) => {
      if (ignore) {
        return
      }
      if (result.error) {
        setCatalogState("error")
        return
      }
      setSuggestions(result.data.models)
      setCatalogState("idle")
    })

    return () => {
      ignore = true
    }
  }, [open, type])

  function handleSubmit(values: CreateInferenceProviderRequestWritable) {
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            {provider ? <ProviderIcon type={provider.type} className="size-4" /> : null}
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
              <Field>
                <FieldLabel required>Provider type</FieldLabel>
                <Controller
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      disabled={Boolean(provider)}
                      onValueChange={(value) => {
                        field.onChange(value)
                        if (value === "OpenAI") form.setValue("openai", {})
                        if (value === "Anthropic") form.setValue("anthropic", {})
                        if (value === "Gemini") form.setValue("gemini", {})
                        setCatalogState("loading")
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providerTypes.map((item) => (
                          <SelectItem key={item} value={item}>
                            <ProviderIcon type={item} className="size-4" />{" "}
                            {providerTypeLabels[item]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[form.formState.errors.type]} />
                {provider ? (
                  <FieldDescription>
                    The provider type cannot be changed after creation.
                  </FieldDescription>
                ) : null}
              </Field>
            </FormSection>

            <FormSection icon={Cable} title="Connection">
              {type === "VertexAI" && (
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
              {type === "Bedrock" && (
                <Field>
                  <FieldLabel required>Region</FieldLabel>
                  <Input
                    placeholder="us-east-1"
                    autoComplete="off"
                    {...form.register("bedrock.region")}
                  />
                  <FieldError errors={[form.getFieldState("bedrock.region").error]} />
                </Field>
              )}
              {type === "Azure" && (
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
              {type === "OpenAICompatible" && (
                <>
                  <Field>
                    <FieldLabel required>Base URL</FieldLabel>
                    <Input
                      type="url"
                      placeholder="https://api.example.com"
                      autoComplete="off"
                      spellCheck={false}
                      {...form.register("openai_compatible.base_url")}
                    />
                    <FieldError errors={[form.getFieldState("openai_compatible.base_url").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Authentication</FieldLabel>
                    <Controller
                      control={form.control}
                      name="openai_compatible.auth_mode"
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
                              "openai_compatible.auth_header",
                              value === "APIKey" ? "authorization" : undefined,
                              { shouldDirty: true, shouldValidate: true }
                            )
                            form.setValue("openai_compatible.auth_prefix", undefined, {
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
                      errors={[form.getFieldState("openai_compatible.auth_mode").error]}
                    />
                  </Field>
                </>
              )}
              {(type === "OpenAI" || type === "Anthropic" || type === "OpenAICompatible") && (
                <Accordion type="single" collapsible className="rounded-lg border">
                  <AccordionItem value="advanced" className="border-none">
                    <AccordionTrigger className="focus-visible:bg-muted/60 px-4 py-3 hover:no-underline focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:rounded-b-none">
                      Advanced
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pt-1 pb-4 [&>div]:h-auto">
                      <FieldGroup>
                        {type === "OpenAI" && (
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
                        {type === "Anthropic" && (
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
                        {type === "OpenAICompatible" && (
                          <>
                            <Field>
                              <FieldLabel>Path</FieldLabel>
                              <Input
                                placeholder="/v1/chat/completions"
                                spellCheck={false}
                                {...form.register("openai_compatible.path", {
                                  setValueAs: (value) => value || undefined,
                                })}
                              />
                              <FieldError
                                errors={[form.getFieldState("openai_compatible.path").error]}
                              />
                            </Field>
                            <Field>
                              <FieldLabel>Path prefix</FieldLabel>
                              <Input
                                placeholder="/v1"
                                spellCheck={false}
                                {...form.register("openai_compatible.path_prefix", {
                                  setValueAs: (value) => value || undefined,
                                })}
                              />
                              <FieldError
                                errors={[form.getFieldState("openai_compatible.path_prefix").error]}
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
                                    {...form.register("openai_compatible.auth_header")}
                                  />
                                  <FieldError
                                    errors={[
                                      form.getFieldState("openai_compatible.auth_header").error,
                                    ]}
                                  />
                                </Field>
                                <Field>
                                  <FieldLabel>Authentication prefix</FieldLabel>
                                  <Input
                                    placeholder="Bearer "
                                    spellCheck={false}
                                    {...form.register("openai_compatible.auth_prefix")}
                                  />
                                  <FieldError
                                    errors={[
                                      form.getFieldState("openai_compatible.auth_prefix").error,
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
                                      {...form.register(`openai_compatible.headers.${index}.name`)}
                                    />
                                    <Input
                                      aria-label={`Header ${index + 1} value`}
                                      placeholder="public-value"
                                      {...form.register(`openai_compatible.headers.${index}.value`)}
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
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
                                          `openai_compatible.headers.${index}.name`
                                        ).error,
                                        form.getFieldState(
                                          `openai_compatible.headers.${index}.value`
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
                                  errors={[form.getFieldState("openai_compatible.headers").error]}
                                />
                              </div>
                            </Field>
                            <Controller
                              control={form.control}
                              name="openai_compatible.allow_private_endpoint"
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
                                form.getFieldState("openai_compatible.allow_private_endpoint")
                                  .error,
                              ]}
                            />
                            <Controller
                              control={form.control}
                              name="openai_compatible.skip_tls_verify"
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
                                form.getFieldState("openai_compatible.skip_tls_verify").error,
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
              {(type === "OpenAI" ||
                type === "Anthropic" ||
                type === "Gemini" ||
                (type === "OpenAICompatible" && customAuthMode === "APIKey") ||
                (type === "Azure" && azureAuthMode === "APIKey")) && (
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
              {type === "VertexAI" && (
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
              {type === "Bedrock" && (
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
              {type === "Azure" && azureAuthMode === "ServicePrincipal" && (
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
              {type === "OpenAICompatible" && customAuthMode === "None" && (
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
              {catalogState === "loading" && (
                <p
                  aria-live="polite"
                  className="text-muted-foreground flex items-center gap-2 text-sm"
                >
                  <Spinner />
                  Loading model catalog…
                </p>
              )}
              {catalogState === "error" && (
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
