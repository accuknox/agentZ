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
  .refine(isSecretHost, "Use a hostname, *.hostname, IP address, or CIDR range")

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
      .transform((hosts) => Array.from(new Set(hosts.map(normalizeSecretHost))).sort())
  )

export const secretFormSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
  hosts: secretHostsInputSchema,
})

export const secretFormInputSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
  hosts: z.string().min(1, "At least one host is required"),
})

const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function isSecretHost(value: string) {
  const host = value.trim()
  if (isCIDR(host) || isIP(host)) {
    return true
  }
  if (host.startsWith("*.")) {
    return isDomain(host.slice(2))
  }
  return isDomain(host)
}

function normalizeSecretHost(value: string) {
  const host = value.trim()
  if (host.startsWith("*.")) {
    return `*.${host.slice(2).toLowerCase().replace(/\.$/, "")}`
  }
  if (isDomain(host)) {
    return host.toLowerCase().replace(/\.$/, "")
  }
  return host
}

function isEnvironmentHost(value: string) {
  const host = value.trim()
  if (isCIDR(host)) {
    return true
  }
  if (isIP(host)) {
    return false
  }
  if (host.startsWith("*.")) {
    return isDomain(host.slice(2))
  }
  if (host.includes("*")) {
    return false
  }
  return isDomain(host)
}

function normalizeEnvironmentHost(value: string) {
  const host = value.trim()
  if (isCIDR(host)) {
    return normalizeCIDR(host)
  }
  if (host.startsWith("*.")) {
    return `*.${host.slice(2).toLowerCase().replace(/\.$/, "")}`
  }
  return host.toLowerCase().replace(/\.$/, "")
}

function isDomain(value: string) {
  const domain = value.trim().replace(/\.$/, "")
  if (domain.length === 0 || domain.length > 253 || domain.includes("..")) {
    return false
  }
  if (isIP(domain)) {
    return false
  }
  return domain.split(".").every((label) => domainLabelPattern.test(label))
}

function isIP(value: string) {
  return ipaddr.isValid(value)
}

function isCIDR(value: string) {
  return ipaddr.isValidCIDR(value)
}

function normalizeCIDR(value: string) {
  const [addr, bits] = ipaddr.parseCIDR(value)
  return `${addr.toString()}/${bits}`
}

export const maxSystemPromptChars = 4096
export const primaryModels = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const
export const summaryModels = ["gpt-5.4-nano", "gpt-5.4-mini"] as const

const requiredNumber = (message: string) =>
  z.number({ error: message }).refine(Number.isFinite, message)

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
  .refine(isEnvironmentHost, "Use a hostname, *.hostname, or CIDR range")
  .transform(normalizeEnvironmentHost)

export const identitySchema = z.object({
  name: agentNameSchema,
  environmentName: environmentNameSchema,
  systemPrompt: z.string().max(maxSystemPromptChars, "System prompt is too long"),
})

export const compactionSchema = z
  .object({
    mode: z.enum(["summary", "truncate"], {
      error: "Compaction mode is required",
    }),
    thresholdRatio: z.number().min(0.2).max(0.95),
    historyToolResultRatio: z.number().min(0).max(1),
    keepRecentRequests: z.number().int().min(0),
    oversizedToolResultRatio: z.number().min(0.05).max(0.1),
    maxHistoryRuns: z.number().int().min(0),
  })
  .refine(
    (value) =>
      value.historyToolResultRatio === 0 ||
      value.historyToolResultRatio < value.oversizedToolResultRatio,
    {
      message: "Must be less than oversized tool result ratio",
      path: ["historyToolResultRatio"],
    }
  )

export const baseModelSchema = z.object({
  primaryName: z.string().min(1, "Primary model is required"),
  primaryContextWindow: requiredNumber("Context window is required")
    .int()
    .min(1, "Context window is required"),
  primaryTemperature: z.number().min(0).max(1),
  summaryName: z.string(),
  summaryContextWindow: requiredNumber("Summary context window is required").int(),
  summaryTemperature: z.number().min(0).max(1),
})

export const modelSchema = baseModelSchema.superRefine((value, ctx) => {
  if (value.summaryName.trim() === "") {
    ctx.addIssue({
      code: "custom",
      message: "Summary model is required",
      path: ["summaryName"],
    })
  }
  if (value.summaryContextWindow <= 0) {
    ctx.addIssue({
      code: "custom",
      message: "Summary context window is required",
      path: ["summaryContextWindow"],
    })
  }
})

export const toolsSchema = z.object({
  hostExec: z.boolean(),
  webFetch: z.boolean(),
  file: z.boolean(),
  arxiv: z.boolean(),
})

export const createEnvironmentFormSchema = z.object({
  name: environmentNameSchema,
  packages: z.array(z.string()),
  allowedHosts: z
    .array(environmentAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})

export const createAgentFormSchema = z
  .object({
    ...identitySchema.shape,
    compactionMode: compactionSchema.shape.mode,
    thresholdRatio: z.coerce.number().min(0.2).max(0.95),
    historyToolResultRatio: z.coerce.number().min(0).max(1),
    keepRecentRequests: z.coerce.number().int().min(0),
    oversizedToolResultRatio: z.coerce.number().min(0.05).max(0.1),
    maxHistoryRuns: z.coerce.number().int().min(0),
    primaryName: baseModelSchema.shape.primaryName,
    primaryContextWindow: z.coerce.number().int().min(1),
    primaryTemperature: z.coerce.number().min(0).max(1),
    summaryName: baseModelSchema.shape.summaryName,
    summaryContextWindow: z.coerce.number().int().min(0),
    summaryTemperature: z.coerce.number().min(0).max(1),
    ...toolsSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (
      value.historyToolResultRatio !== 0 &&
      value.historyToolResultRatio >= value.oversizedToolResultRatio
    ) {
      ctx.addIssue({
        code: "custom",
        message: "must be less than compaction.oversizedToolResultRatio",
        path: ["historyToolResultRatio"],
      })
    }
    if (value.compactionMode === "summary" && value.summaryName.trim() === "") {
      ctx.addIssue({
        code: "custom",
        message: "required",
        path: ["summaryName"],
      })
    }
    if (value.compactionMode === "summary" && value.summaryContextWindow <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "must be greater than zero",
        path: ["summaryContextWindow"],
      })
    }
  })
