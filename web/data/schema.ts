import * as z from "zod"
import ipaddr from "ipaddr.js"
import {
  zAgentName,
  zMcpConnectionName,
  zSandboxName,
  zSecretKey,
} from "@/lib/gateway/client/zod.gen"

const secretKeySchema = zSecretKey

export const secretValueSchema = z
  .string()
  .trim()
  .min(1, "Secret value is required")
  .max(49152, "Secret value must be at most 48 KB")

export const secretHostSchema = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseSecretHost)

export const secretHostsInputSchema = z
  .string()
  .transform((value) =>
    value
      .split(/[\n,]+/)
      .map((host) => host.trim())
      .filter(Boolean)
  )
  .pipe(
    z
      .array(secretHostSchema)
      .min(1, "At least one host is required")
      .max(100, "Use at most 100 hosts")
      .transform((hosts) => Array.from(new Set(hosts)).sort())
  )

export const secretFormInputSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
  hosts: secretHostsInputSchema,
})

const oauthScopesInputSchema = z
  .string()
  .trim()
  .min(1, "At least one scope is required")
  .transform((value) =>
    value
      .split(/\r?\n+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  )

const httpsURLSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "URL must be valid",
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

const optionalHTTPSURLSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (!value) {
      return
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "URL must be valid",
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
  .transform((value) => value || undefined)

export const oauthSecretFormInputSchema = z
  .object({
    key: secretKeySchema,
    endpoint_url: z.string().trim().min(1, "OAuth server is required").pipe(httpsURLSchema),
    hosts: secretHostsInputSchema,
    provider: z
      .string()
      .trim()
      .transform((value) => value || undefined),
    oauth_discovery_state: z.enum(["idle", "discovering", "success", "manual"]).default("idle"),
    client_id: z
      .string()
      .trim()
      .transform((value) => value || undefined),
    client_secret: z
      .string()
      .trim()
      .transform((value) => value || undefined),
    issuer: optionalHTTPSURLSchema,
    authorization_endpoint: optionalHTTPSURLSchema,
    token_endpoint: optionalHTTPSURLSchema,
    registration_endpoint: optionalHTTPSURLSchema,
    resource: optionalHTTPSURLSchema,
    scopes: oauthScopesInputSchema,
  })
  .superRefine((value, ctx) => {
    const hasClientID = Boolean(value.client_id)
    const hasClientSecret = Boolean(value.client_secret)
    const hasRegistrationEndpoint = Boolean(value.registration_endpoint)
    let hasEndpointURL = false
    try {
      const endpointURL = new URL(value.endpoint_url)
      hasEndpointURL =
        endpointURL.protocol === "https:" && !endpointURL.username && !endpointURL.password
    } catch {
      hasEndpointURL = false
    }
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

export const agentNameSchema = z
  .string()
  .trim()
  .min(1, "Agent name is required")
  .max(32, "Agent name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zAgentName)
  .refine((name) => name !== "mcp-connection", "Agent name is reserved")

export const sandboxNameSchema = z
  .string()
  .trim()
  .min(1, "Sandbox name is required")
  .max(32, "Sandbox name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zSandboxName)

export const sandboxAllowedHostSchema = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseSandboxHost)

export const createAgentSimpleFormSchema = z.object({
  name: agentNameSchema,
  sandboxName: sandboxNameSchema,
})

export const updateAgentSimpleFormSchema = z.object({
  sandboxName: sandboxNameSchema,
  model: z.string().trim().min(1).optional(),
  smallModel: z.string().trim().min(1).optional(),
})

export const createSandboxFormSchema = z.object({
  name: sandboxNameSchema,
  packages: z.array(z.string()),
  mcpConnectionRefs: z
    .array(
      z.object({
        name: z.string().trim().min(1, "MCP connection name is required").pipe(zMcpConnectionName),
        tools: z
          .array(
            z.object({
              name: z.string().trim().min(1, "Tool name is required"),
              requireConsent: z.boolean(),
            })
          )
          .min(1),
      })
    )
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
    .array(sandboxAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})
