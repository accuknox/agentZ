import * as z from "zod"

export const secretKeySchema = z
  .string()
  .trim()
  .min(1, "Secret name is required")
  .max(128, "Secret name must be at most 128 characters")
  .regex(/^[A-Za-z0-9_]+$/, "Use letters, numbers, and underscores only")

export const secretValueSchema = z.string().max(49152, "Secret value must be at most 48 KB")

export const secretFormSchema = z.object({
  key: secretKeySchema,
  value: secretValueSchema,
})

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

export const identitySchema = z.object({
  name: agentNameSchema,
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
