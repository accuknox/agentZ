import * as z from "zod"
import { zMcpConnectionName, zMcpConnectionOAuthCredentials } from "@/lib/gateway/client/zod.gen"
import type { JsonObject, McpConnectionAuthLocation } from "@/lib/gateway/client"
import { oauthMaskedPlaceholder } from "@/lib/mcp-oauth-shared"

export const maskedSecretValue = oauthMaskedPlaceholder

const reservedHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "content-length",
])

const httpsURLSchema = z
  .string()
  .trim()
  .min(1, "MCP server URL is required")
  .superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "MCP server URL must be a valid URL",
      })
      return
    }

    if (url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "MCP server URL must use HTTPS",
      })
    }
  })

const nameDraftSchema = z
  .string({
    error: "Must be a valid DNS name. Only Lower-case alphabets, hyphens and dots are allowed.",
  })
  .min(1, "Name is required")
  .transform((value) => value.trim())
  .refine((value) => value.length <= 128, {
    message: "Name must be at most 128 characters",
  })

const extraHeaderSchema = z.object({
  key: z.string().trim(),
  value: z.string().trim(),
})

const baseFormSchema = z.object({
  mode: z.enum(["create", "update"]),
  current_name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  current_auth_mode: z.enum(["none", "bearer", "oauth"]).optional(),
  name: nameDraftSchema,
  endpoint_url: httpsURLSchema,
  endpoint_timeout: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  extra_headers: z.array(extraHeaderSchema),
  auth_mode: z.enum(["bearer", "oauth"]),
  bearer_token: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_scopes: z
    .string()
    .optional()
    .transform((value) => value ?? ""),
  oauth_client_id: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_client_secret: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
})

export type McpFormInput = z.input<typeof baseFormSchema>
export type McpFormValues = z.infer<typeof baseFormSchema>

export const mcpFormSchema = baseFormSchema.superRefine((value, ctx) => {
  if (value.name) {
    const parsedName = zMcpConnectionName.safeParse(value.name)
    if (!parsedName.success) {
      for (const issue of parsedName.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: ["name"],
          message: issue.message,
        })
      }
    }
  }

  for (const [index, header] of value.extra_headers.entries()) {
    if (!header.key || !header.value) {
      if (!header.key) {
        ctx.addIssue({
          code: "custom",
          path: ["extra_headers", index, "key"],
          message: "Header key is required",
        })
      }
      if (!header.value) {
        ctx.addIssue({
          code: "custom",
          path: ["extra_headers", index, "value"],
          message: "Header value is required",
        })
      }
      continue
    }

    if (reservedHeaderNames.has(header.key.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        path: ["extra_headers", index, "key"],
        message: `Header "${header.key}" is reserved`,
      })
    }
  }

  if (value.auth_mode === "bearer") {
    const needsToken =
      value.mode === "create" ||
      value.current_auth_mode !== "bearer" ||
      (value.bearer_token !== undefined && value.bearer_token !== maskedSecretValue)
    if (needsToken && !value.bearer_token) {
      ctx.addIssue({
        code: "custom",
        path: ["bearer_token"],
        message: "Token is required",
      })
    }
    return
  }

  const hasClientId = Boolean(value.oauth_client_id) && value.oauth_client_id !== maskedSecretValue
  const hasClientSecret =
    Boolean(value.oauth_client_secret) && value.oauth_client_secret !== maskedSecretValue
  const useDcr = !hasClientId && !hasClientSecret

  if (!useDcr && !hasClientId && value.oauth_client_id !== maskedSecretValue) {
    ctx.addIssue({
      code: "custom",
      path: ["oauth_client_id"],
      message: "Client ID is required",
    })
  }

  if (!useDcr && !hasClientSecret && value.oauth_client_secret !== maskedSecretValue) {
    ctx.addIssue({
      code: "custom",
      path: ["oauth_client_secret"],
      message: "Client secret is required",
    })
  }
})

export type ParsedMcpForm = {
  mode: "create" | "update"
  currentName?: string
  currentAuthMode: "none" | "bearer" | "oauth"
  name: string
  endpoint: {
    url: string
    timeout?: string
    insecure_skip_verify: boolean
    headers: Record<string, string>
  }
  authMode: "bearer" | "oauth"
  bearerToken?: string
  preserveBearerToken: boolean
  oauth: {
    scopes?: string[]
    clientId?: string
    clientSecret?: string
    preserveClientId: boolean
    preserveClientSecret: boolean
  }
}

export function parseMcpForm(values: McpFormValues): ParsedMcpForm {
  const name = zMcpConnectionName.parse(values.name)

  const headers = Object.fromEntries(
    values.extra_headers
      .filter((header) => header.key && header.value)
      .map((header) => [header.key, header.value] as const)
  )
  const scopes = values.oauth_scopes
    .split(/[\n,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
  const preserveBearerToken =
    values.mode === "update" &&
    values.current_auth_mode === "bearer" &&
    values.bearer_token === maskedSecretValue
  const preserveClientId =
    values.mode === "update" &&
    values.current_auth_mode === "oauth" &&
    values.oauth_client_id === maskedSecretValue
  const preserveClientSecret =
    values.mode === "update" &&
    values.current_auth_mode === "oauth" &&
    values.oauth_client_secret === maskedSecretValue

  return {
    mode: values.mode,
    currentName: values.current_name,
    currentAuthMode: values.current_auth_mode ?? "none",
    name,
    endpoint: {
      url: values.endpoint_url,
      timeout: values.endpoint_timeout,
      insecure_skip_verify: false,
      headers,
    },
    authMode: values.auth_mode,
    bearerToken: preserveBearerToken ? undefined : values.bearer_token,
    preserveBearerToken,
    oauth: {
      scopes: scopes.length > 0 ? scopes : undefined,
      clientId: preserveClientId ? undefined : values.oauth_client_id,
      clientSecret: preserveClientSecret ? undefined : values.oauth_client_secret,
      preserveClientId,
      preserveClientSecret,
    },
  }
}

export function mcpAuthLocation(): McpConnectionAuthLocation {
  return {
    header: {
      name: "Authorization",
      prefix: "Bearer",
    },
  }
}

export function oauthCredentialsFromTokens(input: {
  clientId?: string
  clientSecret?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  tokenType?: string
  scopes?: string[]
  registration?: JsonObject
}) {
  return zMcpConnectionOAuthCredentials.parse({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    expires_at: input.expiresAt,
    token_type: input.tokenType,
    scopes: input.scopes,
    registration: input.registration,
  })
}
