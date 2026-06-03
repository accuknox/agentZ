import * as z from "zod"
import type {
  JsonObject,
  McpConnectionDetail,
  McpConnectionAuthLocation,
  McpConnectionHeaderLocation,
} from "@/lib/gateway/client"
import {
  zMcpConnectionAuthLocation,
  zMcpConnectionName,
  zMcpConnectionOAuthCredentials,
} from "@/lib/gateway/client/zod.gen"

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

const authLocationHeaderFormSchema = z.object({
  name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  prefix: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
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
  oauth_discovery_state: z
    .enum(["idle", "discovering", "success", "manual"])
    .optional()
    .default("idle"),
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
  oauth_issuer: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_authorization_endpoint: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_token_endpoint: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_registration_endpoint: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  oauth_resource: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
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

export type McpFormInput = z.input<typeof baseFormSchema>
export type McpFormValues = z.infer<typeof baseFormSchema>

export const mcpFormSchema = baseFormSchema.superRefine((value, ctx) => {
  if (value.mode === "update" && value.current_name && value.name.trim() !== value.current_name) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "Name cannot be changed while updating an MCP connection",
    })
  }

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
    const parsedBearerLocation = zMcpConnectionAuthLocation.safeParse({
      header: locationHeaderInput(
        value.bearer_location_header_name,
        value.bearer_location_header_prefix
      ),
    })
    if (!parsedBearerLocation.success) {
      for (const issue of parsedBearerLocation.error.issues) {
        const path =
          issue.path.at(-1) === "name"
            ? ["bearer_location_header_name"]
            : issue.path.at(-1) === "prefix"
              ? ["bearer_location_header_prefix"]
              : ["bearer_location_header_name"]
        ctx.addIssue({
          code: "custom",
          path,
          message: issue.message,
        })
      }
    }
    return
  }

  const hasClientId = Boolean(value.oauth_client_id)
  const hasClientSecret = Boolean(value.oauth_client_secret)
  const useDcr = !hasClientId && !hasClientSecret
  const needsManualOAuthFields = value.oauth_discovery_state === "manual"
  const hasRegistrationEndpoint = Boolean(value.oauth_registration_endpoint)
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

  if (needsManualOAuthFields || value.oauth_discovery_state === "success") {
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

  if (needsManualOAuthFields) {
    if (useDcr && !value.oauth_registration_endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["oauth_registration_endpoint"],
        message: "Registration endpoint is required",
      })
    }
  }

  const parsedOAuthLocation = zMcpConnectionAuthLocation.safeParse({
    header: locationHeaderInput(
      value.oauth_location_header_name,
      value.oauth_location_header_prefix
    ),
  })
  if (!parsedOAuthLocation.success) {
    for (const issue of parsedOAuthLocation.error.issues) {
      const path =
        issue.path.at(-1) === "name"
          ? ["oauth_location_header_name"]
          : issue.path.at(-1) === "prefix"
            ? ["oauth_location_header_prefix"]
            : ["oauth_location_header_name"]
      ctx.addIssue({
        code: "custom",
        path,
        message: issue.message,
      })
    }
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
  bearer?: {
    location?: McpConnectionAuthLocation
  }
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

function locationHeaderInput(name?: string, prefix?: string) {
  const parsed = authLocationHeaderFormSchema.parse({
    name,
    prefix,
  })
  if (!parsed.name && !parsed.prefix) {
    return undefined
  }
  return parsed satisfies Partial<McpConnectionHeaderLocation>
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
    bearerToken: values.bearer_token,
    bearer: {
      location: authLocationFromHeaderInput(
        values.bearer_location_header_name,
        values.bearer_location_header_prefix
      ),
    },
    oauth: {
      issuer: values.oauth_issuer,
      authorizationEndpoint: values.oauth_authorization_endpoint,
      tokenEndpoint: values.oauth_token_endpoint,
      registrationEndpoint: values.oauth_registration_endpoint,
      resource: values.oauth_resource,
      scopes: scopes.length > 0 ? scopes : undefined,
      location: authLocationFromHeaderInput(
        values.oauth_location_header_name,
        values.oauth_location_header_prefix
      ),
      clientId: values.oauth_client_id,
      clientSecret: values.oauth_client_secret,
    },
  }
}

function authLocationFromHeaderInput(
  name?: string,
  prefix?: string
): McpConnectionAuthLocation | undefined {
  const header = locationHeaderInput(name, prefix)
  if (!header) {
    return undefined
  }

  return zMcpConnectionAuthLocation.parse({
    header,
  })
}

export function mcpAuthLocation(): McpConnectionAuthLocation {
  return {
    header: {
      name: "Authorization",
      prefix: "Bearer",
    },
  }
}

export function formAuthLocation(input?: McpConnectionAuthLocation) {
  return {
    headerName: input?.header?.name ?? "Authorization",
    headerPrefix: input?.header?.prefix ?? "Bearer",
  }
}

export function formOAuthDefaults(connection?: McpConnectionDetail) {
  const oauth = connection?.auth?.oauth
  const location = formAuthLocation(oauth?.location)

  return {
    oauth_issuer: oauth?.issuer ?? "",
    oauth_authorization_endpoint: oauth?.authorization_endpoint ?? "",
    oauth_token_endpoint: oauth?.token_endpoint ?? "",
    oauth_registration_endpoint: oauth?.registration_endpoint ?? "",
    oauth_resource: oauth?.resource ?? "",
    oauth_scopes: oauth?.scopes?.join("\n") ?? "",
    oauth_location_header_name: location.headerName,
    oauth_location_header_prefix: location.headerPrefix,
  }
}

export function formBearerDefaults(connection?: McpConnectionDetail) {
  const location = formAuthLocation(connection?.auth?.bearer?.location)

  return {
    bearer_location_header_name: location.headerName,
    bearer_location_header_prefix: location.headerPrefix,
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
