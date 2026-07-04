import * as z from "zod"
import type { JsonObject, McpConnectionAuthLocation } from "@/lib/gateway/client"
import { zMcpConnectionName, zMcpConnectionOAuthCredentials } from "@/lib/gateway/client/zod.gen"

const reservedHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "content-length",
])

const authLocationHeaderSchema = z.object({
  name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  prefix: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value.trim())),
})

const optionalHTTPSURLSchema = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)
  .superRefine((value, ctx) => {
    if (value === undefined) {
      return
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "URL must be a valid URL",
      })
      return
    }

    if (url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "URL must use HTTPS",
      })
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: "custom",
        message: "URL must not include credentials",
      })
    }
  })

const oauthScopesInputSchema = z
  .string()
  .optional()
  .transform((value) => value ?? "")
  .transform((value) =>
    value
      .split(/[\n,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  )

export const defaultMcpAuthLocation = {
  header: {
    name: "Authorization",
    prefix: "Bearer",
  },
} satisfies McpConnectionAuthLocation

const authLocationResultSchema = authLocationHeaderSchema.superRefine((value, ctx) => {
  if (!value.name && value.prefix !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "Header name is required when a prefix is set",
    })
  }
})

const formSchema = z.object({
  name: z
    .string({
      error: "Must be a valid DNS name. Only Lower-case alphabets, hyphens and dots are allowed.",
    })
    .trim()
    .min(1, "Name is required")
    .refine((value) => value.length <= 128, {
      message: "Name must be at most 128 characters",
    }),
  endpoint_url: z
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
      if (url.username || url.password) {
        ctx.addIssue({
          code: "custom",
          message: "MCP server URL must not include credentials",
        })
      }
    }),
  endpoint_timeout: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  extra_headers: z.array(
    z.object({
      key: z.string().trim(),
      value: z.string().trim(),
    })
  ),
  auth_mode: z.enum(["bearer", "oauth"]),
  oauth_discovery_state: z.enum(["idle", "discovering", "success", "manual"]).default("idle"),
  bearer_token: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_scopes: oauthScopesInputSchema,
  oauth_client_id: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_client_secret: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_issuer: optionalHTTPSURLSchema,
  oauth_authorization_endpoint: optionalHTTPSURLSchema,
  oauth_token_endpoint: optionalHTTPSURLSchema,
  oauth_registration_endpoint: optionalHTTPSURLSchema,
  oauth_resource: optionalHTTPSURLSchema,
  oauth_location_header_name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_location_header_prefix: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  bearer_location_header_name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  bearer_location_header_prefix: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
})

export type McpFormInput = z.input<typeof formSchema>
export type McpFormValues = z.output<typeof formSchema>

function authLocationIssues(
  kind: "bearer" | "oauth",
  location: z.infer<typeof authLocationHeaderSchema>
) {
  const parsed = authLocationResultSchema.safeParse(location)
  if (parsed.success) {
    return []
  }

  return parsed.error.issues.map((issue) => ({
    path: [
      issue.path.at(-1) === "prefix"
        ? `${kind}_location_header_prefix`
        : `${kind}_location_header_name`,
    ],
    message: issue.message,
  }))
}

export const mcpFormSchema = formSchema.superRefine((value, ctx) => {
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
    if (!value.bearer_token) {
      ctx.addIssue({
        code: "custom",
        path: ["bearer_token"],
        message: "Token is required",
      })
    }

    for (const issue of authLocationIssues("bearer", {
      name: value.bearer_location_header_name,
      prefix: value.bearer_location_header_prefix,
    })) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      })
    }
    return
  }

  const hasClientId = Boolean(value.oauth_client_id)
  const hasClientSecret = Boolean(value.oauth_client_secret)
  const hasRegistrationEndpoint = Boolean(value.oauth_registration_endpoint)
  const needsManualFields = value.oauth_discovery_state === "manual"
  const discoveryNeedsClientCredentials =
    value.oauth_discovery_state === "success" && !hasRegistrationEndpoint
  const needsClientCredentials = hasClientId || hasClientSecret || discoveryNeedsClientCredentials

  if (needsClientCredentials && !hasClientId) {
    ctx.addIssue({
      code: "custom",
      path: ["oauth_client_id"],
      message: "Client ID is required",
    })
  }

  if (needsClientCredentials && !hasClientSecret) {
    ctx.addIssue({
      code: "custom",
      path: ["oauth_client_secret"],
      message: "Client secret is required",
    })
  }

  if (needsManualFields || value.oauth_discovery_state === "success") {
    if (!value.oauth_issuer) {
      ctx.addIssue({
        code: "custom",
        path: ["oauth_issuer"],
        message: "Issuer is required",
      })
    }
    if (!value.oauth_authorization_endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["oauth_authorization_endpoint"],
        message: "Authorization endpoint is required",
      })
    }
    if (!value.oauth_token_endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["oauth_token_endpoint"],
        message: "Token endpoint is required",
      })
    }
  }

  if (needsManualFields && !hasClientId && !hasClientSecret && !hasRegistrationEndpoint) {
    ctx.addIssue({
      code: "custom",
      path: ["oauth_registration_endpoint"],
      message: "Registration endpoint is required",
    })
  }

  for (const issue of authLocationIssues("oauth", {
    name: value.oauth_location_header_name,
    prefix: value.oauth_location_header_prefix,
  })) {
    ctx.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
    })
  }
})

function authLocationFromInputs(
  name?: string,
  prefix?: string
): McpConnectionAuthLocation | undefined {
  const parsed = authLocationResultSchema.parse({ name, prefix })
  if (!parsed.name) {
    return undefined
  }

  return {
    header: {
      name: parsed.name,
      ...(parsed.prefix !== undefined ? { prefix: parsed.prefix } : {}),
    },
  }
}

export type ParsedMcpForm = {
  name: string
  endpoint: {
    url: string
    timeout?: string
    insecure_skip_verify: boolean
    headers: Record<string, string>
  }
  authMode: "bearer" | "oauth"
  bearerToken?: string
  bearerLocation?: McpConnectionAuthLocation
  oauth: {
    issuer?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
    registrationEndpoint?: string
    resource?: string
    scopes?: string[]
    location?: McpConnectionAuthLocation
    clientId?: string
    clientSecret?: string
  }
}

export function parseMcpForm(values: McpFormValues): ParsedMcpForm {
  const headers = Object.fromEntries(
    values.extra_headers
      .filter((header) => header.key && header.value)
      .map<[string, string]>((header) => [header.key, header.value])
  )

  return {
    name: zMcpConnectionName.parse(values.name),
    endpoint: {
      url: values.endpoint_url,
      timeout: values.endpoint_timeout,
      insecure_skip_verify: false,
      headers,
    },
    authMode: values.auth_mode,
    bearerToken: values.bearer_token,
    bearerLocation: authLocationFromInputs(
      values.bearer_location_header_name,
      values.bearer_location_header_prefix
    ),
    oauth: {
      issuer: values.oauth_issuer,
      authorizationEndpoint: values.oauth_authorization_endpoint,
      tokenEndpoint: values.oauth_token_endpoint,
      registrationEndpoint: values.oauth_registration_endpoint,
      resource: values.oauth_resource,
      scopes: values.oauth_scopes.length > 0 ? values.oauth_scopes : undefined,
      location: authLocationFromInputs(
        values.oauth_location_header_name,
        values.oauth_location_header_prefix
      ),
      clientId: values.oauth_client_id,
      clientSecret: values.oauth_client_secret,
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
