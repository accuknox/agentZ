import * as z from "zod"
import ipaddr from "ipaddr.js"
import {
  zAgentName,
  zMcpConnectionName,
  zSandboxName,
  zSecretKey,
  zSkillName,
} from "@/lib/gateway/client/zod.gen"

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

export const secretValueSchema = z
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

export const secretHostsInputSchema = z
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
  name: z
    .string({ error: "MCP connection name is required" })
    .trim()
    .min(1, "MCP connection name is required")
    .pipe(zMcpConnectionName),
  tools: z
    .array(selectedMcpToolSchema, { error: "MCP tools must be a list" })
    .min(1, "Select at least one MCP tool"),
})

const optionalModelSchema = z
  .string({ error: "Model must be text" })
  .trim()
  .min(1, "Model is required")
  .optional()

const optionalSmallModelSchema = z
  .string({ error: "Small model must be text" })
  .trim()
  .min(1, "Small model is required")
  .optional()

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
    return canonicalCIDR(host)
  }
  if (ipaddr.isValid(host)) {
    return allowIP ? host : undefined
  }
  if (host.startsWith("**.")) {
    const domain = canonicalDomain(host.slice(3))
    return domain ? `**.${domain}` : undefined
  }
  if (host.startsWith("*.")) {
    const domain = canonicalDomain(host.slice(2))
    return domain ? `*.${domain}` : undefined
  }
  if (host.includes("*")) {
    return undefined
  }
  return canonicalDomain(host)
}

function canonicalDomain(value: string) {
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

function canonicalCIDR(value: string) {
  const [addr, bits] = ipaddr.parseCIDR(value)
  return `${addr.toString()}/${bits}`
}

export const agentNameSchema = agentNameInputSchema
export const sandboxNameSchema = sandboxNameInputSchema
export const skillNameSchema = z
  .string({ error: "Skill name is required" })
  .trim()
  .min(1, "Skill name is required")
  .max(32, "Skill name must be at most 32 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name is invalid")
  .pipe(zSkillName)
export const sandboxAllowedHostSchema = z
  .string({ error: "Host is required" })
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseSandboxHost)

export const createAgentSimpleFormSchema = z.object({
  name: agentNameSchema,
  sandboxName: sandboxNameSchema,
  skills: z.array(skillNameSchema, { error: "Skills must be a list" }),
})

export const updateAgentSimpleFormSchema = z.object({
  sandboxName: sandboxNameSchema,
  skills: z.array(skillNameSchema, { error: "Skills must be a list" }),
  model: optionalModelSchema,
  smallModel: optionalSmallModelSchema,
})

export const createSandboxFormSchema = z.object({
  name: sandboxNameSchema,
  skills: z.array(skillNameSchema, { error: "Skills must be a list" }),
  packages: z.array(sandboxPackageSchema, { error: "Packages must be a list" }),
  mcpConnectionRefs: z
    .array(selectedMcpConnectionSchema, { error: "MCP connections must be a list" })
    .superRefine((refs, ctx) => {
      const names = new Set<string>()
      for (const [index, ref] of refs.entries()) {
        if (names.has(ref.name)) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate MCP connection references are not allowed",
            path: [index, "name"],
          })
          continue
        }
        names.add(ref.name)

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
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((ref) => ({
          name: ref.name,
          tools: ref.tools.toSorted((a, b) => a.name.localeCompare(b.name)),
        }))
    ),
  allowedHosts: z
    .array(sandboxAllowedHostSchema, { error: "Allowed hosts must be a list" })
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})
