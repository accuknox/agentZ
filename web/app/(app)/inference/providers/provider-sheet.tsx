"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import {
  Brain,
  Cable,
  Check,
  ChevronsUpDown,
  CircleAlert,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  Save,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import * as React from "react"
import {
  Controller,
  useController,
  useFieldArray,
  useForm,
  useWatch,
  type Control,
  type FieldPath,
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
  pollInferenceProviderOAuthAction,
  refreshInferenceProviderModelsAction,
  saveInferenceProviderAction,
  startInferenceProviderOAuthAction,
  suggestInferenceModelsAction,
  type InferenceProviderActionScope,
} from "@/data/inference-provider.actions"
import { formatCompactNumber } from "@/lib/format"
import {
  type CreateInferenceProviderOAuthTicketResponse,
  type InferenceModel,
  type InferenceModelModality,
  type InferenceProvider,
  type InferenceProviderCatalogEntry,
  type InferenceProviderWriteDiscriminatorWritable,
} from "@/lib/gateway/client"
import { zInferenceProviderWriteDiscriminatorWritable } from "@/lib/gateway/client/zod.gen"
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

type SubscriptionOAuthState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "challenge"
      verificationUri: string
      userCode: string
      interval: number
      expiresAt: string
    }
  | { status: "connected"; connection: CreateInferenceProviderOAuthTicketResponse }
  | { status: "error"; message: string }

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
  capabilities: z.object(
    {
      attachment: z.boolean({ error: "Choose whether this model accepts attachments" }),
      reasoning: z.boolean({ error: "Choose whether this model supports reasoning" }),
      temperature: z.boolean({ error: "Choose whether this model supports temperature" }),
      tool_call: z.boolean({ error: "Choose whether this model can call tools" }),
    },
    { error: "Choose the model capabilities" }
  ),
  modalities: z.object(
    {
      input: z
        .array(z.enum(modalities, { error: "Select a supported input modality" }), {
          error: "Choose the model's supported input types",
        })
        .min(1, { error: "Select at least one input modality" }),
      output: z
        .array(z.enum(modalities, { error: "Select a supported output modality" }), {
          error: "Choose the model's supported output types",
        })
        .min(1, { error: "Select at least one output modality" }),
    },
    { error: "Choose the model's supported input and output types" }
  ),
  limits: z.object(
    {
      context: z
        .int({ error: "Enter the context limit as a whole number" })
        .gte(1, { error: "Context limit must be at least 1" })
        .lte(2147483647, { error: "Context limit must be at most 2,147,483,647" }),
      input: z
        .int({ error: "Enter maximum input tokens as a whole number" })
        .gte(1, { error: "Maximum input tokens must be at least 1" })
        .lte(2147483647, { error: "Maximum input tokens must be at most 2,147,483,647" })
        .optional(),
      output: z
        .int({ error: "Enter maximum output tokens as a whole number" })
        .gte(1, { error: "Maximum output tokens must be at least 1" })
        .lte(2147483647, { error: "Maximum output tokens must be at most 2,147,483,647" }),
    },
    { error: "Enter the model's token limits" }
  ),
  api: z
    .enum(["ChatCompletions", "Responses", "Messages"], {
      error: "Choose an API format supported by this model",
    })
    .optional(),
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
  type: z.literal("service_account", {
    error: 'Service account JSON must set type to "service_account"',
  }),
  project_id: z
    .string({ error: "Service account JSON must include a project_id" })
    .min(1, { error: "Service account JSON must include a project_id" }),
  private_key: z
    .string({ error: "Service account JSON must include a private_key" })
    .min(1, { error: "Service account JSON must include a private_key" }),
  client_email: z
    .string({ error: "Service account JSON must include a client_email" })
    .min(1, { error: "Service account JSON must include a client_email" }),
  token_uri: z
    .string({ error: "Service account JSON must include a token_uri" })
    .min(1, { error: "Service account JSON must include a token_uri" }),
})

const googleCredentialTypeSchema = z.object({
  type: z.string({ error: "Google credential JSON must include a type" }),
})

const serviceAccountJSONSchema = z
  .string({ error: "Service account JSON must be text" })
  .max(49152, { error: "Service account JSON must be at most 48 KB" })
  .superRefine((document, ctx) => {
    if (!document.trim()) {
      return
    }
    let json: unknown
    try {
      json = JSON.parse(document)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Service account JSON must be valid JSON",
      })
      return
    }
    const credentialType = googleCredentialTypeSchema.safeParse(json)
    if (credentialType.success && credentialType.data.type === "authorized_user") {
      ctx.addIssue({
        code: "custom",
        message:
          "This is an authorized-user OAuth credential. Upload a service-account key JSON instead.",
      })
      return
    }
    const parsed = serviceAccountDocumentSchema.safeParse(json)
    if (parsed.success) {
      return
    }
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
      })
    }
  })
  .optional()

const compatibleProviderConfigSchema = z.object({
  base_url: z
    .url({ error: "Enter a valid provider base URL" })
    .max(2048, { error: "Provider base URL must be at most 2,048 characters" }),
  path: z
    .string({ error: "Provider path must be text" })
    .max(1024, { error: "Provider path must be at most 1,024 characters" })
    .regex(/^\/[^?#]*$/, {
      error: "Provider path must start with / and cannot include a query or fragment",
    })
    .optional(),
  path_prefix: z
    .string({ error: "Provider path prefix must be text" })
    .max(1024, { error: "Provider path prefix must be at most 1,024 characters" })
    .regex(/^\/[^?#]*$/, {
      error: "Provider path prefix must start with / and cannot include a query or fragment",
    })
    .optional(),
  auth_mode: z.enum(["None", "APIKey"], {
    error: "Choose API-key authentication or no authentication",
  }),
  auth_header: z
    .string({ error: "Authentication header must be text" })
    .min(1, { error: "Enter the authentication header name" })
    .max(128, { error: "Authentication header must be at most 128 characters" })
    .regex(/^[a-z0-9!#$%&'*+.^_|~-]+$/, {
      error: "Enter a valid lowercase HTTP header name",
    })
    .optional(),
  auth_prefix: z
    .string({ error: "Authentication prefix must be text" })
    .max(128, { error: "Authentication prefix must be at most 128 characters" })
    .optional(),
  headers: z
    .array(
      z.object({
        name: z
          .string({ error: "Header name is required" })
          .min(1, { error: "Enter a header name" })
          .max(128, { error: "Header name must be at most 128 characters" })
          .regex(/^[a-z0-9!#$%&'*+.^_|~-]+$/, {
            error: "Enter a valid lowercase HTTP header name",
          }),
        value: z
          .string({ error: "Header value is required" })
          .min(1, { error: "Enter a header value" })
          .max(1024, { error: "Header value must be at most 1,024 characters" }),
      }),
      { error: "Static headers must be a list of names and values" }
    )
    .max(32, { error: "Add no more than 32 static headers" })
    .optional(),
  allow_private_endpoint: z
    .boolean({ error: "Choose whether private endpoints are allowed" })
    .optional()
    .default(false),
  skip_tls_verify: z
    .boolean({ error: "Choose whether TLS verification is required" })
    .optional()
    .default(false),
})

const providerServerErrorFields = new Map<
  string,
  FieldPath<InferenceProviderWriteDiscriminatorWritable>
>([
  ["display_name", "display_name"],
  ["catalog_provider", "catalog_provider"],
  ["kind", "catalog_provider"],
  ["openai.base_url", "openai.base_url"],
  ["anthropic.base_url", "anthropic.base_url"],
  ["gemini.base_url", "gemini.base_url"],
  ["vertex_ai", "vertex_ai.project"],
  ["vertex_ai.project", "vertex_ai.project"],
  ["vertex_ai.region", "vertex_ai.region"],
  ["bedrock", "bedrock.region"],
  ["bedrock.region", "bedrock.region"],
  ["bedrock.auth_mode", "bedrock.auth_mode"],
  ["azure", "azure.resource_name"],
  ["azure.resource_name", "azure.resource_name"],
  ["azure.project", "azure.project"],
  ["azure.api_version", "azure.api_version"],
  ["azure.auth_mode", "azure.auth_mode"],
  ["credentials.api_key", "credentials.api_key"],
  ["credentials.service_account_json", "credentials.service_account_json"],
  ["credentials.access_key", "credentials.access_key"],
  ["credentials.secret_key", "credentials.secret_key"],
  ["credentials.session_token", "credentials.session_token"],
  ["credentials.bearer_token", "credentials.bearer_token"],
  ["credentials.client_id", "credentials.client_id"],
  ["credentials.tenant_id", "credentials.tenant_id"],
  ["credentials.client_secret", "credentials.client_secret"],
  ["openai_compatible", "openai_compatible.base_url"],
  ["openai_compatible.base_url", "openai_compatible.base_url"],
  ["openai_compatible.path", "openai_compatible.path"],
  ["openai_compatible.path_prefix", "openai_compatible.path_prefix"],
  ["openai_compatible.auth_mode", "openai_compatible.auth_mode"],
  ["openai_compatible.auth_header", "openai_compatible.auth_header"],
  ["openai_compatible.auth_prefix", "openai_compatible.auth_prefix"],
  ["openai_compatible.headers", "openai_compatible.headers"],
  ["openai_compatible.allow_private_endpoint", "openai_compatible.allow_private_endpoint"],
  ["openai_compatible.skip_tls_verify", "openai_compatible.skip_tls_verify"],
  ["anthropic_compatible", "anthropic_compatible.base_url"],
  ["anthropic_compatible.base_url", "anthropic_compatible.base_url"],
  ["anthropic_compatible.path", "anthropic_compatible.path"],
  ["anthropic_compatible.path_prefix", "anthropic_compatible.path_prefix"],
  ["anthropic_compatible.auth_mode", "anthropic_compatible.auth_mode"],
  ["anthropic_compatible.auth_header", "anthropic_compatible.auth_header"],
  ["anthropic_compatible.auth_prefix", "anthropic_compatible.auth_prefix"],
  ["anthropic_compatible.headers", "anthropic_compatible.headers"],
  ["anthropic_compatible.allow_private_endpoint", "anthropic_compatible.allow_private_endpoint"],
  ["anthropic_compatible.skip_tls_verify", "anthropic_compatible.skip_tls_verify"],
])

function getProviderServerErrorField(
  path: string
): FieldPath<InferenceProviderWriteDiscriminatorWritable> | undefined {
  const field = path.startsWith("provider.") ? path.slice("provider.".length) : path
  const mapped = providerServerErrorFields.get(field)
  if (mapped) {
    return mapped
  }
  if (/^models\.\d+(\.|$)/.test(field)) {
    return field as FieldPath<InferenceProviderWriteDiscriminatorWritable>
  }
  if (/^(openai_compatible|anthropic_compatible)\.headers\.\d+(\.(name|value))?$/.test(field)) {
    return field as FieldPath<InferenceProviderWriteDiscriminatorWritable>
  }
  if (field === "models") {
    return field
  }
  return undefined
}

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
        catalog_provider: z.literal("openai", {
          error: "Select OpenAI Codex from the provider list",
        }),
        kind: z.literal("OpenAICodex", { error: "Select OpenAI Codex as the provider kind" }),
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
        catalog_provider: z.literal("github-copilot", {
          error: "Select GitHub Copilot from the provider list",
        }),
        kind: z.literal("GitHubCopilot", {
          error: "Select GitHub Copilot as the provider kind",
        }),
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
          service_account_json: serviceAccountJSONSchema,
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
        openai_compatible: compatibleProviderConfigSchema,
        credentials: apiKeyCredentialsSchema,
      }),
      z.object({
        ...providerFields,
        kind: z.literal("AnthropicCompatible", {
          error: "Select Anthropic-compatible as the provider kind",
        }),
        anthropic_compatible: compatibleProviderConfigSchema,
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
  scope,
}: {
  provider?: InferenceProvider
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: InferenceProviderActionScope
}) {
  const defaults = provider
    ? zInferenceProviderWriteDiscriminatorWritable.parse(
        provider.kind === "OpenAICodex" || provider.kind === "GitHubCopilot"
          ? provider
          : { ...provider, credentials: {} }
      )
    : ({
        display_name: "",
        catalog_provider: "openai",
        kind: "OpenAI",
        openai: {},
        models: [],
        credentials: {},
      } satisfies InferenceProviderWriteDiscriminatorWritable)
  const formSchema = React.useMemo(
    () =>
      providerFormSchema.superRefine((values, ctx) => {
        const isCreate = provider === undefined
        if (values.kind === "OpenAICodex" || values.kind === "GitHubCopilot") {
          return
        }
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
  const form = useForm<InferenceProviderWriteDiscriminatorWritable>({
    defaultValues: defaults,
    resolver: zodResolver(formSchema),
    criteriaMode: "all",
  })
  const models = useFieldArray({ control: form.control, name: "models", keyName: "key" })
  const kind = useWatch({ control: form.control, name: "kind", defaultValue: defaults.kind })
  const isSubscription = kind === "OpenAICodex" || kind === "GitHubCopilot"
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
  const [subscriptionOAuth, setSubscriptionOAuth] = React.useState<SubscriptionOAuthState>({
    status: "idle",
  })
  const [impact, setImpact] = React.useState<{
    values: InferenceProviderWriteDiscriminatorWritable
    pools: string[]
    sandboxes: string[]
  }>()
  const [pending, startTransition] = React.useTransition()

  React.useEffect(() => {
    if (!open) {
      return
    }

    let ignore = false
    void listInferenceProviderCatalogAction(scope).then((result) => {
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
  }, [open, scope])

  React.useEffect(() => {
    if (!open || !catalogProvider || (isSubscription && !provider)) {
      return
    }

    let ignore = false
    let request = suggestInferenceModelsAction(scope, catalogProvider, kind)
    if (isSubscription) {
      if (!provider) {
        return
      }
      request = refreshInferenceProviderModelsAction(scope, provider.id)
    }
    void request.then((result) => {
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
  }, [catalogProvider, isSubscription, kind, open, provider, scope])

  React.useEffect(() => {
    if (!open || subscriptionOAuth.status !== "challenge") {
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = (interval: number) => {
      timer = setTimeout(() => {
        void pollInferenceProviderOAuthAction(scope).then((result) => {
          if (cancelled) {
            return
          }
          if (result.status === "pending") {
            poll(result.interval)
            return
          }
          if (result.status === "error") {
            setSubscriptionOAuth(result)
            return
          }
          setSubscriptionOAuth(result)
          setSubmitError("")
          setSubmitErrors([])
          setSuggestions(result.connection.models)
          models.replace(result.connection.models)
          setModelCatalogState("idle")
        })
      }, interval * 1000)
    }
    poll(subscriptionOAuth.interval)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [models, open, scope, subscriptionOAuth])

  const selectedCatalogEntry = catalog.find(
    (entry) => entry.provider_id === catalogProvider && entry.provider_kind === kind
  )

  function connectSubscription() {
    if (kind !== "OpenAICodex" && kind !== "GitHubCopilot") {
      return
    }
    setSubscriptionOAuth({ status: "starting" })
    setSubmitError("")
    startTransition(async () => {
      const result = await startInferenceProviderOAuthAction(scope, kind)
      setSubscriptionOAuth(result)
      if (result.status !== "challenge") {
        return
      }
      window.open(result.verificationUri, "_blank", "noopener,noreferrer")
    })
  }

  function save(values: InferenceProviderWriteDiscriminatorWritable) {
    setSubmitError("")
    setSubmitErrors([])
    form.clearErrors()
    startTransition(async () => {
      const result = provider
        ? await saveInferenceProviderAction(scope, {
            providerName: provider.id,
            body: {
              provider: values,
              resource_version: provider.resource_version,
            },
          })
        : await saveInferenceProviderAction(scope, {
            body: {
              provider: values,
              oauth_ticket:
                subscriptionOAuth.status === "connected"
                  ? subscriptionOAuth.connection.ticket
                  : undefined,
            },
          })
      if (result.error) {
        const details: string[] = []
        let shouldFocus = true
        for (const error of result.error.errors ?? []) {
          const errorField = error.field.startsWith("provider.")
            ? error.field.slice("provider.".length)
            : error.field
          if (errorField === "oauth_ticket") {
            setSubscriptionOAuth({ status: "error", message: error.message })
            continue
          }
          const field = getProviderServerErrorField(error.field)
          if (field) {
            form.setError(field, { type: "server", message: error.message }, { shouldFocus })
            shouldFocus = false
            continue
          }
          details.push(error.message)
        }
        if (!result.error.errors?.length || details.length > 0) {
          setSubmitError(result.error.message)
          setSubmitErrors(details)
        }
        return
      }
      toast.success(provider ? "Inference provider updated" : "Inference provider created")
      form.reset()
      onOpenChange(false)
    })
  }

  function handleSubmit(values: InferenceProviderWriteDiscriminatorWritable) {
    if (!provider) {
      if (isSubscription && subscriptionOAuth.status !== "connected") {
        setSubmitError("Connect the subscription before adding this provider")
        return
      }
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
      const result = await getInferenceProviderUsageAction(scope, provider.id)
      if (result.error) {
        setSubmitError(result.error.message)
        return
      }
      const pools = result.usage?.pools ?? []
      if (pools.length === 0) {
        save(values)
        return
      }
      setImpact({
        values,
        pools,
        sandboxes: result.usage?.sandboxes ?? [],
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
          onSubmit={form.handleSubmit(handleSubmit, () => {
            setSubmitError("")
            setSubmitErrors([])
          })}
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
                  aria-invalid={Boolean(form.formState.errors.display_name)}
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
                          aria-invalid={Boolean(
                            form.formState.errors.catalog_provider || form.formState.errors.kind
                          )}
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
                          <CommandInput placeholder="Search providers..." />
                          <CommandList>
                            <CommandEmpty>No provider found.</CommandEmpty>
                            <CommandGroup>
                              {catalog.map((entry) => (
                                <CommandItem
                                  key={`${entry.provider_id}:${entry.provider_kind}`}
                                  value={`${entry.name} ${entry.provider_id} ${providerKindLabels[entry.provider_kind]}`}
                                  onSelect={() => {
                                    setModelCatalogState("loading")
                                    setSubscriptionOAuth({ status: "idle" })
                                    const displayName = form.getFieldState("display_name").isDirty
                                      ? form.getValues("display_name")
                                      : entry.name
                                    const common = {
                                      catalog_provider: entry.provider_id,
                                      display_name: displayName,
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
                                      case "OpenAICodex":
                                        setModelCatalogState("idle")
                                        form.reset({
                                          catalog_provider: "openai",
                                          display_name: displayName,
                                          models: [],
                                          kind: "OpenAICodex",
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
                                      case "GitHubCopilot":
                                        setModelCatalogState("idle")
                                        form.reset({
                                          catalog_provider: "github-copilot",
                                          display_name: displayName,
                                          models: [],
                                          kind: "GitHubCopilot",
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
                    <Input
                      autoComplete="off"
                      aria-invalid={form.getFieldState("vertex_ai.project").invalid}
                      {...form.register("vertex_ai.project")}
                    />
                    <FieldError errors={[form.getFieldState("vertex_ai.project").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required>Region</FieldLabel>
                    <Input
                      placeholder="us-central1"
                      autoComplete="off"
                      aria-invalid={form.getFieldState("vertex_ai.region").invalid}
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
                      aria-invalid={form.getFieldState("bedrock.region").invalid}
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
                      render={({ field, fieldState }) => (
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
                          <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
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
                      render={({ field, fieldState }) => (
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
                          <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
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
                    <Input
                      autoComplete="off"
                      aria-invalid={form.getFieldState("azure.resource_name").invalid}
                      {...form.register("azure.resource_name")}
                    />
                    <FieldError errors={[form.getFieldState("azure.resource_name").error]} />
                  </Field>
                  {azureResourceType === "Foundry" && (
                    <Field>
                      <FieldLabel required>Foundry project</FieldLabel>
                      <Input
                        autoComplete="off"
                        aria-invalid={form.getFieldState("azure.project").invalid}
                        {...form.register("azure.project")}
                      />
                      <FieldError errors={[form.getFieldState("azure.project").error]} />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel required>API version</FieldLabel>
                    <Input
                      placeholder="2025-04-01-preview"
                      autoComplete="off"
                      aria-invalid={form.getFieldState("azure.api_version").invalid}
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
                      render={({ field, fieldState }) => (
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
                          <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
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
                      aria-invalid={form.getFieldState(`${compatibleField}.base_url`).invalid}
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
                      render={({ field, fieldState }) => (
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
                          <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
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
                              aria-invalid={form.getFieldState("openai.base_url").invalid}
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
                              aria-invalid={form.getFieldState("anthropic.base_url").invalid}
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
                              aria-invalid={form.getFieldState("gemini.base_url").invalid}
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
                                aria-invalid={form.getFieldState(`${compatibleField}.path`).invalid}
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
                                aria-invalid={
                                  form.getFieldState(`${compatibleField}.path_prefix`).invalid
                                }
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
                                    aria-invalid={
                                      form.getFieldState(`${compatibleField}.auth_header`).invalid
                                    }
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
                                    aria-invalid={
                                      form.getFieldState(`${compatibleField}.auth_prefix`).invalid
                                    }
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
                                      aria-invalid={
                                        form.getFieldState(
                                          `${compatibleField}.headers.${index}.name`
                                        ).invalid
                                      }
                                      {...form.register(`${compatibleField}.headers.${index}.name`)}
                                    />
                                    <Input
                                      aria-label={`Header ${index + 1} value`}
                                      placeholder="public-value"
                                      aria-invalid={
                                        form.getFieldState(
                                          `${compatibleField}.headers.${index}.value`
                                        ).invalid
                                      }
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
                                    aria-invalid={form.getFieldState(field.name).invalid}
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
                                    aria-invalid={form.getFieldState(field.name).invalid}
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
              title={isSubscription ? "Subscription" : "Credentials"}
              description={
                isSubscription
                  ? "Sign in to use your existing subscription."
                  : provider
                    ? "Leave blank to keep the current credentials."
                    : undefined
              }
            >
              {isSubscription && provider ? (
                <Alert>
                  <Check />
                  <AlertTitle>Connected</AlertTitle>
                  <AlertDescription>Your subscription is ready to use.</AlertDescription>
                </Alert>
              ) : null}
              {isSubscription && !provider ? (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Connect {providerKindLabels[kind]}</p>
                      <p className="text-muted-foreground text-sm">
                        Sign in to your account in a new tab. This page will update when you are
                        done.
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={connectSubscription}
                      disabled={
                        pending ||
                        subscriptionOAuth.status === "starting" ||
                        subscriptionOAuth.status === "challenge" ||
                        subscriptionOAuth.status === "connected"
                      }
                    >
                      {subscriptionOAuth.status === "starting" ? <Spinner /> : <Cable />}
                      Connect
                    </Button>
                  </div>
                  {subscriptionOAuth.status === "challenge" ? (
                    <div className="bg-muted/40 space-y-3 rounded-md border p-3">
                      <p className="text-muted-foreground text-sm">
                        Enter this one-time code on the sign-in page, then return here.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="bg-background flex-1 rounded border px-3 py-2 text-center text-lg font-semibold tracking-widest">
                          {subscriptionOAuth.userCode}
                        </code>
                        <CopyButton content={subscriptionOAuth.userCode} />
                      </div>
                      <Button type="button" variant="outline" asChild>
                        <a
                          href={subscriptionOAuth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Continue to {providerKindLabels[kind]} <ExternalLink />
                        </a>
                      </Button>
                      <p className="text-muted-foreground flex items-center gap-2 text-xs">
                        <Spinner className="size-3" /> Waiting for you to finish signing in...
                      </p>
                    </div>
                  ) : null}
                  {subscriptionOAuth.status === "connected" ? (
                    <Alert>
                      <Check />
                      <AlertTitle>Connected</AlertTitle>
                      <AlertDescription>
                        Choose the models you want to make available, then add the provider.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {subscriptionOAuth.status === "error" ? (
                    <Alert variant="destructive">
                      <CircleAlert />
                      <AlertTitle>Connection failed</AlertTitle>
                      <AlertDescription>{subscriptionOAuth.message}</AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              ) : null}
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
                    aria-invalid={form.getFieldState("credentials.api_key").invalid}
                    {...form.register("credentials.api_key")}
                  />
                  <FieldError errors={[form.getFieldState("credentials.api_key").error]} />
                </Field>
              )}
              {kind === "VertexAI" && (
                <ServiceAccountJsonField control={form.control} required={!provider} />
              )}
              {kind === "Bedrock" && bedrockAuthMode === "AccessKey" && (
                <>
                  <Field>
                    <FieldLabel required={!provider}>Access key</FieldLabel>
                    <Input
                      type="password"
                      spellCheck={false}
                      autoComplete="new-password"
                      aria-invalid={form.getFieldState("credentials.access_key").invalid}
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
                      aria-invalid={form.getFieldState("credentials.secret_key").invalid}
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
                      aria-invalid={form.getFieldState("credentials.session_token").invalid}
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
                    aria-invalid={form.getFieldState("credentials.bearer_token").invalid}
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
                      aria-invalid={form.getFieldState("credentials.client_id").invalid}
                      {...form.register("credentials.client_id")}
                    />
                    <FieldError errors={[form.getFieldState("credentials.client_id").error]} />
                  </Field>
                  <Field>
                    <FieldLabel required={!provider}>Tenant ID</FieldLabel>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={form.getFieldState("credentials.tenant_id").invalid}
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
                      aria-invalid={form.getFieldState("credentials.client_secret").invalid}
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
                  allowCustomValues={!isSubscription}
                  disabled={isSubscription && !provider && subscriptionOAuth.status !== "connected"}
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
                  searchPlaceholder={
                    isSubscription ? "Search available models..." : "Search or enter a model ID..."
                  }
                  emptyMessage={
                    isSubscription
                      ? "Connect your subscription to see available models."
                      : "No catalog models found. Enter a model ID."
                  }
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
                  Loading model catalog...
                </p>
              )}
              {modelCatalogState === "error" && (
                <Alert variant="warning">
                  <TriangleAlert />
                  <AlertTitle>Model catalog unavailable</AlertTitle>
                  <AlertDescription>
                    {isSubscription
                      ? "Reconnect or reopen the form to retry."
                      : "You can still enter model IDs manually."}
                  </AlertDescription>
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
                    {!isSubscription ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${model.display_name} metadata`}
                        onClick={() => setEditingModel(index)}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
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
              <Button
                type="submit"
                disabled={
                  pending ||
                  (!provider && isSubscription && subscriptionOAuth.status !== "connected")
                }
              >
                {pending ? <Spinner /> : <Save data-icon="inline-start" />}
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
 * ServiceAccountJsonField isolates the controlled JSON input's value and error
 * subscriptions while also supporting file import.
 */
function ServiceAccountJsonField({
  control,
  required,
}: {
  control: Control<InferenceProviderWriteDiscriminatorWritable>
  required: boolean
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const { field, fieldState } = useController({
    control,
    name: "credentials.service_account_json",
  })

  return (
    <Field data-invalid={fieldState.invalid}>
      <FieldLabel required={required}>Service account JSON</FieldLabel>
      <div className="space-y-2">
        <Textarea
          {...field}
          value={field.value ?? ""}
          className="min-h-36 font-mono text-xs"
          spellCheck={false}
          aria-invalid={fieldState.invalid}
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Import service account JSON"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) {
              return
            }
            void file.text().then(field.onChange)
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <Upload />
          Import JSON file
        </Button>
      </div>
      <FieldError errors={[fieldState.error]} />
    </Field>
  )
}

/**
 * ModelMetadataDialog edits one model's display name, limits, capabilities,
 * and modalities.
 */
function ModelMetadataDialog({
  form,
  editingModel,
  onCloseAction,
}: {
  form: ReturnType<typeof useForm<InferenceProviderWriteDiscriminatorWritable>>
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
        </DialogHeader>
        {editingModel !== undefined && (
          <div className="space-y-4">
            <Field>
              <FieldLabel required>Display name</FieldLabel>
              <Input
                aria-invalid={form.getFieldState(`models.${editingModel}.display_name`).invalid}
                {...form.register(`models.${editingModel}.display_name`)}
              />
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
                  aria-invalid={form.getFieldState(`models.${editingModel}.limits.context`).invalid}
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
                  render={({ field, fieldState }) => (
                    <Input
                      type="number"
                      min={1}
                      aria-invalid={fieldState.invalid}
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
                  aria-invalid={form.getFieldState(`models.${editingModel}.limits.output`).invalid}
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
                    render={({ field, fieldState }) => (
                      <label className="hover:bg-muted/50 has-data-checked:border-primary/40 has-data-checked:bg-primary/5 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm capitalize transition-colors">
                        <Checkbox
                          checked={field.value}
                          aria-invalid={fieldState.invalid}
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
                render={({ field, fieldState }) => (
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
                            aria-invalid={fieldState.invalid}
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
