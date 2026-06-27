import cron from "cron-validate"
import * as z from "zod"
import type {
  WorkflowInputScalarValue,
  WorkflowInputSchema,
  WorkflowInputs,
} from "@/lib/gateway/client"
import { agentNameSchema } from "@/data/schema"

const workflowNameSchema = agentNameSchema.describe("Workflow name")

export const workflowScheduleNameSchema = agentNameSchema.describe("Schedule name")

const workflowScheduleFieldSchema = z.union([z.string(), z.number(), z.boolean(), z.undefined()])

const workflowScheduleInputsSchema = z.record(z.string(), workflowScheduleFieldSchema)

type WorkflowScheduleInputValue = string | number | boolean | undefined

const createWorkflowScheduleFormSchema = z.object({
  name: workflowScheduleNameSchema,
  workflow_name: workflowNameSchema,
  schedule: z
    .string()
    .trim()
    .min(1, "Schedule is required")
    .refine((value) => !value.includes("TZ=") && !value.includes("CRON_TZ="), {
      message: "Set timezone separately. Do not include TZ= or CRON_TZ= in the schedule.",
    })
    .refine(
      (value) =>
        cron(value, {
          preset: "default",
          override: {
            useAliases: true,
            useBlankDay: false,
            useYears: false,
            useSeconds: false,
          },
        }).isValid(),
      {
        message: "Use a valid 5-field cron expression",
      }
    ),
  time_zone: z.string().trim().min(1, "Timezone is required"),
  timeout_seconds: z
    .number({ error: "Timeout must be a number" })
    .int("Timeout must be a whole number")
    .min(1, "Timeout must be at least 1 second")
    .max(604800, "Timeout must be at most 604800 seconds"),
  successful_runs_history_limit: z
    .number({ error: "Successful runs history limit is required" })
    .int("Successful runs history limit must be a whole number")
    .min(1, "Successful runs history limit must be at least 1")
    .max(10, "Successful runs history limit must be at most 10"),
  failed_runs_history_limit: z
    .number({ error: "Failed runs history limit is required" })
    .int("Failed runs history limit must be a whole number")
    .min(1, "Failed runs history limit must be at least 1")
    .max(10, "Failed runs history limit must be at most 10"),
  inputs: workflowScheduleInputsSchema,
})

export type CreateWorkflowScheduleFormValues = z.infer<typeof createWorkflowScheduleFormSchema>

export function buildWorkflowScheduleFormSchema(inputSchema: WorkflowInputs) {
  return createWorkflowScheduleFormSchema.extend({
    inputs: buildWorkflowInputObjectSchema(inputSchema),
  })
}

function buildWorkflowInputObjectSchema(inputSchema: WorkflowInputs) {
  const shape: Record<string, z.ZodType<WorkflowScheduleInputValue>> = {}

  for (const [name, input] of Object.entries(inputSchema)) {
    shape[name] = input.required
      ? buildWorkflowInputValueSchema(input)
      : buildWorkflowInputValueSchema(input).optional()
  }

  return z.strictObject(shape)
}

export function workflowInputDefaultValues(inputSchema: WorkflowInputs) {
  const values: Record<string, WorkflowScheduleInputValue> = {}

  for (const [name, input] of Object.entries(inputSchema)) {
    values[name] = input.default
  }

  return values
}

function buildWorkflowInputValueSchema(input: WorkflowInputSchema) {
  let schema: z.ZodType<Exclude<WorkflowScheduleInputValue, undefined>>

  switch (input.type) {
    case "boolean":
      schema = z.boolean({
        error: (issue) => (issue.input === undefined ? "Required" : "Value must be true or false"),
      })
      break
    case "integer":
      schema = buildWorkflowNumberSchema(input, true)
      break
    case "number":
      schema = buildWorkflowNumberSchema(input, false)
      break
    case "string":
      schema = buildWorkflowStringSchema(input)
      break
  }

  if (input.enum && input.enum.length > 0) {
    const enumValues = input.enum
    schema = schema.refine((value) => enumValues.some((item) => item === value), {
      message: `Must be one of ${enumValues.map((value) => JSON.stringify(value)).join(", ")}`,
    })
  }

  return schema
}

function buildWorkflowStringSchema(input: WorkflowInputSchema) {
  let schema = z.string({
    error: (issue) => (issue.input === undefined ? "Required" : "Value must be a string"),
  })

  if (input.minLength !== undefined) {
    schema = schema.min(input.minLength)
  }
  if (input.maxLength !== undefined) {
    schema = schema.max(input.maxLength)
  }
  if (input.pattern !== undefined) {
    schema = schema.regex(new RegExp(input.pattern), "Value does not match the required pattern")
  }

  switch (input.format) {
    case "date":
      schema = schema.refine((value) => dateStringPattern.test(value), {
        message: "Use a valid date",
      })
      break
    case "date-time":
      schema = schema.refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "Use a valid date and time",
      })
      break
    case "email":
      schema = schema.email("Use a valid email address")
      break
    case "uri":
      schema = schema.url("Use a valid URL")
      break
    case "uuid":
      schema = schema.uuid("Use a valid UUID")
      break
    case undefined:
      break
  }

  return schema
}

function buildWorkflowNumberSchema(input: WorkflowInputSchema, integer: boolean) {
  let schema = integer
    ? z.int({
        error: (issue) => (issue.input === undefined ? "Required" : "Value must be a whole number"),
      })
    : z.number({
        error: (issue) => (issue.input === undefined ? "Required" : "Value must be a number"),
      })

  if (input.minimum !== undefined) {
    schema = schema.gte(input.minimum)
  }
  if (input.maximum !== undefined) {
    schema = schema.lte(input.maximum)
  }
  if (input.exclusiveMinimum !== undefined) {
    schema = schema.gt(input.exclusiveMinimum)
  }
  if (input.exclusiveMaximum !== undefined) {
    schema = schema.lt(input.exclusiveMaximum)
  }
  if (input.multipleOf !== undefined) {
    schema = schema.multipleOf(input.multipleOf)
  }

  return schema
}

const dateStringPattern = /^\d{4}-\d{2}-\d{2}$/
