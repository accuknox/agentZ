import * as z from "zod"
import ipaddr from "ipaddr.js"

export const secretKeySchema = z
  .string()
  .trim()
  .min(1, "Secret name is required")
  .max(128, "Secret name must be at most 128 characters")
  .regex(/^[A-Za-z0-9_]+$/, "Use letters, numbers, and underscores only")

export const secretValueSchema = z
  .string()
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
  hosts: z.string().min(1, "At least one host is required"),
})

const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function parseSecretHost(value: string, ctx: z.RefinementCtx) {
  const host = parseHost(value, true)
  if (!host) {
    ctx.addIssue({
      code: "custom",
      message: "Use a hostname, *.hostname, IP address, or CIDR range",
    })
    return z.NEVER
  }
  return host
}

function parseEnvironmentHost(value: string, ctx: z.RefinementCtx) {
  const host = parseHost(value, false)
  if (!host) {
    ctx.addIssue({
      code: "custom",
      message: "Use a hostname, *.hostname, or CIDR range",
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

export const environmentNameSchema = z
  .string()
  .trim()
  .min(1, "Environment name is required")
  .max(32, "Environment name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")

export const environmentAllowedHostSchema = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(253, "Host must be at most 253 characters")
  .transform(parseEnvironmentHost)

export const createAgentSimpleFormSchema = z.object({
  name: agentNameSchema,
  environmentName: environmentNameSchema,
})

export const updateAgentSimpleFormSchema = z.object({
  environmentName: environmentNameSchema,
})

export const createEnvironmentFormSchema = z.object({
  name: environmentNameSchema,
  packages: z.array(z.string()),
  mcpConnectionRefs: z
    .array(
      z.object({
        name: z.string().trim().min(1, "MCP connection name is required"),
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
    .array(environmentAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})
