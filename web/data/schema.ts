import * as z from "zod"
import ipaddr from "ipaddr.js"
import {
  zAgentName,
  zAgentOpencodeConfig,
  zMcpConnectionName,
  zResourceReference,
  zResourceScope,
  zSandboxName,
  zSandboxInference,
  zSecretKey,
  zSkillName,
} from "@/lib/gateway/client/zod.gen"

export const delegationScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "inference:use",
  "mcp:use",
]

export const oauthApplicationInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter an application name.")
      .max(100, "Use 100 characters or fewer."),
    type: z.enum(["confidential", "browser", "native"]),
    redirectUris: z
      .array(z.url({ error: "Enter a valid callback URL." }))
      .min(1, "Enter at least one callback URL.")
      .max(10, "Use at most 10 callback URLs."),
    authorizedOrigins: z
      .array(
        z
          .string()
          .refine(
            (value) => /^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) && !/[\p{Cc}\s]/u.test(value),
            "Use an absolute HTTP(S) origin without a path, query, fragment, or whitespace."
          )
          .pipe(z.url({ protocol: /^https?$/ }))
          .transform((value, ctx) => {
            const url = new URL(value)
            if (
              value.includes("@") ||
              url.hostname.includes("*") ||
              (url.protocol === "http:" &&
                !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value))
            ) {
              ctx.addIssue({
                code: "custom",
                message:
                  "Use an HTTPS origin without a path, query, fragment, credentials, or wildcard. HTTP is allowed only for localhost, 127.0.0.1, or [::1].",
              })
              return z.NEVER
            }
            return url.origin
          })
      )
      .max(10, "Use at most 10 authorized origins.")
      .transform((origins) => [...new Set(origins)]),
    scopes: z
      .array(z.string().refine((scope) => delegationScopes.includes(scope), "Unsupported scope"))
      .min(1, "Select at least one scope."),
  })
  .superRefine((input, ctx) => {
    if (
      input.type === "browser" ? !input.authorizedOrigins.length : input.authorizedOrigins.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["authorizedOrigins"],
        message:
          "Browser applications require 1–10 authorized origins. Other client types cannot register origins.",
      })
    }
    for (const uri of input.redirectUris) {
      const parsed = new URL(uri)
      if (uri.includes("#") || parsed.username || parsed.password || uri.includes("*")) {
        ctx.addIssue({
          code: "custom",
          path: ["redirectUris"],
          message: "Callback URLs must be exact and omit fragments, credentials, and wildcards.",
        })
      }
    }
  })

export const secretKeySchema = z
  .string({ error: "Secret name is required" })
  .trim()
  .min(1, "Secret name is required")
  .max(128, "Secret name must be at most 128 characters")
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "Use letters, numbers, and underscores; start with a letter or underscore"
  )
  .pipe(zSecretKey)

const secretValueSchema = z
  .string({ error: "Secret value is required" })
  .trim()
  .min(1, "Secret value is required")
  .max(49152, "Secret value must be at most 48 KB")

export const secretHostSchema = z
  .string({ error: "Host is required" })
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseSecretHost)

const secretHostsInputSchema = z
  .string({ error: "Hosts are required" })
  .transform((value) =>
    value
      .split(/[\n,]+/)
      .map((host) => host.trim())
      .filter(Boolean)
  )
  .pipe(
    z
      .array(secretHostSchema, { error: "Secret hosts must be a list" })
      .min(1, "At least one host is required")
      .max(100, "Use at most 100 hosts")
      .transform((hosts) => Array.from(new Set(hosts)).sort())
  )

export const secretFormInputSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
  hosts: secretHostsInputSchema,
})

const httpsURLSchema = z
  .url({ protocol: /^https$/, error: "OAuth server must be a valid HTTPS URL" })
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password
  }, "OAuth server URL must not include credentials")

const endpointURLSchema = z
  .string({ error: "OAuth server is required" })
  .trim()
  .min(1, "OAuth server is required")
  .pipe(httpsURLSchema)

function fieldHTTPSURLSchema(label: string) {
  return z
    .string({ error: `${label} must be text` })
    .trim()
    .transform((value) => value || undefined)
    .pipe(
      z
        .url({ protocol: /^https$/, error: `${label} must be a valid HTTPS URL` })
        .refine((value) => {
          const url = new URL(value)
          return !url.username && !url.password
        }, `${label} must not include credentials`)
        .optional()
    )
}

const oauthEndpointURLsSchema = {
  issuer: fieldHTTPSURLSchema("Issuer"),
  authorization_endpoint: fieldHTTPSURLSchema("Authorization endpoint"),
  token_endpoint: fieldHTTPSURLSchema("Token endpoint"),
  registration_endpoint: fieldHTTPSURLSchema("Registration endpoint"),
  resource: fieldHTTPSURLSchema("Resource"),
}

const oauthClientIDSchema = z
  .string({ error: "Client ID must be text" })
  .trim()
  .transform((value) => value || undefined)

const oauthClientSecretSchema = z
  .string({ error: "Client secret must be text" })
  .trim()
  .transform((value) => value || undefined)

const oauthProviderSchema = z
  .string({ error: "Provider must be text" })
  .trim()
  .transform((value) => value || undefined)

const oauthDiscoveryStateSchema = z.enum(["idle", "discovering", "success", "manual"], {
  error: "OAuth discovery state is invalid",
})

const sandboxPackageSchema = z.string({ error: "Package name must be text" }).trim()
const mcpToolConsentSchema = z.boolean({ error: "Tool consent setting must be true or false" })

const selectedMcpToolSchema = z.object({
  name: z.string({ error: "Tool name is required" }).trim().min(1, "Tool name is required"),
  requireConsent: mcpToolConsentSchema,
})

const selectedMcpConnectionSchema = z.object({
  scope: zResourceScope,
  name: z
    .string({ error: "MCP connection name is required" })
    .trim()
    .min(1, "MCP connection name is required")
    .pipe(zMcpConnectionName),
  tools: z
    .array(selectedMcpToolSchema, { error: "MCP tools must be a list" })
    .min(1, "Select at least one MCP tool"),
})

const oauthSecretScopesSchema = z
  .string({ error: "Scopes must be text" })
  .trim()
  .min(1, "At least one scope is required")
  .transform((value) =>
    value
      .split(/\r?\n+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  )

const oauthSecretFormBaseSchema = z.object({
  key: secretKeySchema,
  endpoint_url: endpointURLSchema,
  hosts: secretHostsInputSchema,
  provider: oauthProviderSchema,
  oauth_discovery_state: oauthDiscoveryStateSchema.default("idle"),
  client_id: oauthClientIDSchema,
  client_secret: oauthClientSecretSchema,
  issuer: oauthEndpointURLsSchema.issuer,
  authorization_endpoint: oauthEndpointURLsSchema.authorization_endpoint,
  token_endpoint: oauthEndpointURLsSchema.token_endpoint,
  registration_endpoint: oauthEndpointURLsSchema.registration_endpoint,
  resource: oauthEndpointURLsSchema.resource,
  scopes: oauthSecretScopesSchema,
})

export const oauthSecretFormInputSchema = oauthSecretFormBaseSchema.superRefine((value, ctx) => {
  const hasClientID = Boolean(value.client_id)
  const hasClientSecret = Boolean(value.client_secret)
  const hasRegistrationEndpoint = Boolean(value.registration_endpoint)
  const hasEndpointURL = endpointURLSchema.safeParse(value.endpoint_url).success
  const hasRequiredOAuthMetadata = Boolean(
    value.issuer && value.authorization_endpoint && value.token_endpoint
  )
  const needsManualFields =
    value.oauth_discovery_state === "manual" ||
    (value.oauth_discovery_state === "idle" && hasEndpointURL)
  const needsOAuthMetadata = needsManualFields || value.oauth_discovery_state === "success"
  const discoveryNeedsClientCredentials =
    value.oauth_discovery_state === "success" && !hasRegistrationEndpoint
  const providerNeedsClientCredentials = value.provider === "gws" && !hasRegistrationEndpoint
  const needsClientCredentials = Boolean(
    hasClientID ||
    hasClientSecret ||
    discoveryNeedsClientCredentials ||
    (providerNeedsClientCredentials && hasRequiredOAuthMetadata)
  )

  if (value.oauth_discovery_state === "discovering") {
    ctx.addIssue({
      code: "custom",
      path: ["endpoint_url"],
      message: "OAuth discovery is still running.",
    })
  }

  if (needsClientCredentials && !hasClientID) {
    ctx.addIssue({
      code: "custom",
      path: ["client_id"],
      message: "Client ID is required.",
    })
  }

  if (needsClientCredentials && !hasClientSecret) {
    ctx.addIssue({
      code: "custom",
      path: ["client_secret"],
      message: "Client secret is required.",
    })
  }

  if (needsOAuthMetadata) {
    if (!value.issuer) {
      ctx.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "Issuer is required.",
      })
    }
    if (!value.authorization_endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["authorization_endpoint"],
        message: "Authorization endpoint is required.",
      })
    }
    if (!value.token_endpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["token_endpoint"],
        message: "Token endpoint is required.",
      })
    }
  }

  if (
    needsManualFields &&
    !providerNeedsClientCredentials &&
    !hasClientID &&
    !hasClientSecret &&
    !hasRegistrationEndpoint
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["registration_endpoint"],
      message: "Registration endpoint is required.",
    })
  }
})

/*
 * Keep the field-specific schemas close to the form schema. The gateway Zod
 * stubs still own the final wire-format constraints through .pipe(...).
 */
const agentNameInputSchema = z
  .string({ error: "Agent name is required" })
  .trim()
  .min(1, "Agent name is required")
  .max(32, "Agent name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zAgentName)
  .refine((name) => name !== "mcp-connection", "Agent name is reserved")

const sandboxNameInputSchema = z
  .string({ error: "Sandbox name is required" })
  .trim()
  .min(1, "Sandbox name is required")
  .max(32, "Sandbox name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zSandboxName)

/*
 * Host canonicalization is part of the domain model: form input accepts user
 * spelling, while the API receives the canonical hostname/CIDR representation.
 */
const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function parseSecretHost(value: string, ctx: z.RefinementCtx) {
  const host = parseHost(value, true)
  if (!host) {
    ctx.addIssue({
      code: "custom",
      message: "Use a hostname, *.hostname, **.hostname, IP address, or CIDR range",
    })
    return z.NEVER
  }
  return host
}

function parseSandboxHost(value: string, ctx: z.RefinementCtx) {
  const host = parseHost(value, false)
  if (!host) {
    ctx.addIssue({
      code: "custom",
      message: "Use a hostname, *.hostname, **.hostname, or CIDR range",
    })
    return z.NEVER
  }
  return host
}

function parseHost(value: string, allowIP: boolean) {
  const host = value.trim()
  if (ipaddr.isValidCIDR(host)) {
    const [address, bits] = ipaddr.parseCIDR(host)
    return `${address.toString()}/${bits}`
  }
  if (ipaddr.isValid(host)) {
    return allowIP ? host : undefined
  }
  if (host.startsWith("**.")) {
    const domain = parseDomain(host.slice(3))
    return domain ? `**.${domain}` : undefined
  }
  if (host.startsWith("*.")) {
    const domain = parseDomain(host.slice(2))
    return domain ? `*.${domain}` : undefined
  }
  if (host.includes("*")) {
    return undefined
  }
  return parseDomain(host)
}

function parseDomain(value: string) {
  const domain = value.trim().replace(/\.$/, "")
  if (domain.length === 0 || domain.length > 253 || domain.includes("..")) {
    return undefined
  }
  if (ipaddr.isValid(domain)) {
    return undefined
  }
  if (!domain.split(".").every((label) => domainLabelPattern.test(label))) {
    return undefined
  }
  return domain.toLowerCase()
}

export const sandboxNameSchema = sandboxNameInputSchema
export const sandboxAllowedHostSchema = z
  .string({ error: "Host is required" })
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseSandboxHost)

export const createAgentSimpleFormSchema = z.object({
  name: agentNameInputSchema,
  sandboxScope: zResourceScope,
  sandboxName: sandboxNameSchema,
  skills: z.array(zResourceReference.extend({ name: zSkillName })),
  memoryEnabled: z.boolean(),
  instruction: zAgentOpencodeConfig.shape.instruction.unwrap(),
})

export const createSandboxFormSchema = z.object({
  name: sandboxNameSchema,
  skills: z.array(zResourceReference, { error: "Skills must be a list" }),
  packages: z.array(sandboxPackageSchema, { error: "Packages must be a list" }),
  mcpConnectionRefs: z
    .array(selectedMcpConnectionSchema, { error: "MCP connections must be a list" })
    .superRefine((refs, ctx) => {
      const references = new Set<string>()
      for (const [index, ref] of refs.entries()) {
        const reference = JSON.stringify([ref.scope, ref.name])
        if (references.has(reference)) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate MCP connection references are not allowed",
            path: [index, "name"],
          })
          continue
        }
        references.add(reference)

        const toolNames = new Set<string>()
        for (const [toolIndex, tool] of ref.tools.entries()) {
          if (!toolNames.has(tool.name)) {
            toolNames.add(tool.name)
            continue
          }
          ctx.addIssue({
            code: "custom",
            message: "Duplicate enabled tools are not allowed",
            path: [index, "tools", toolIndex, "name"],
          })
        }
      }
    })
    .transform((refs) =>
      refs
        .toSorted((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
        .map((ref) => ({
          scope: ref.scope,
          name: ref.name,
          tools: ref.tools.toSorted((a, b) => a.name.localeCompare(b.name)),
        }))
    ),
  allowedHosts: z
    .array(sandboxAllowedHostSchema, { error: "Allowed hosts must be a list" })
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
  inference: zSandboxInference,
})

export const organizationNameSchema = z
  .string()
  .min(1, "Enter an Organization name.")
  .max(100, "Use 100 characters or fewer.")
  .refine((name) => name.trim() === name, {
    message: "Remove leading or trailing spaces.",
  })
export const organizationNameInputSchema = z.object({
  name: organizationNameSchema,
})
export const roleNameSchema = z
  .string()
  .min(1, "Enter a Role name.")
  .max(80, "Use 80 characters or fewer.")
  .refine((name) => name.trim() === name, "Remove leading or trailing spaces.")

export const teamFormSchema = z.object({
  name: z
    .string()
    .min(1, "Enter a Team name.")
    .max(100, "Use 100 characters or fewer.")
    .refine((name) => name.trim() === name, "Remove leading or trailing spaces."),
  memberIds: z.array(z.string().min(1)).min(1, "Select at least one active Member.").max(1_000),
  roleIds: z.array(z.string().min(1)).max(1_000),
  updatedAt: z.string().optional(),
})
export const socialAdmissionFormSchema = z
  .object({
    enabled: z.boolean(),
    githubEnabled: z.boolean(),
    githubOrganizations: z.array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
        .or(z.literal(""))
    ),
    githubTeams: z.array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .or(z.literal(""))
    ),
    googleDomains: z.array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)
    ),
    googleEnabled: z.boolean(),
    roleIds: z.array(z.string().min(1)),
    teamIds: z.array(z.string().min(1)),
  })
  .superRefine((data, ctx) => {
    if (data.githubEnabled && data.githubOrganizations.length !== data.githubTeams.length) {
      ctx.addIssue({ code: "custom", message: "GitHub rules are incomplete." })
    }
    if (data.githubEnabled) {
      data.githubOrganizations.forEach((organization, index) => {
        if (organization) return
        ctx.addIssue({
          code: "custom",
          message: "Enter an Organization for every GitHub rule.",
          path: ["githubOrganizations", index],
        })
      })
    }
    if (data.enabled && data.roleIds.length + data.teamIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "Select at least one default Role or Team." })
    }
    if (data.enabled && !data.googleEnabled && !data.githubEnabled) {
      ctx.addIssue({ code: "custom", message: "Enable Google or GitHub." })
    }
    if (data.enabled && data.googleEnabled && data.googleDomains.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Add at least one Google email domain.",
        path: ["googleDomains"],
      })
    }
    if (data.enabled && data.githubEnabled && data.githubOrganizations.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Add at least one GitHub rule.",
        path: ["githubOrganizations"],
      })
    }
  })

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a Workspace name.")
  .max(100, "Use 100 characters or fewer.")
