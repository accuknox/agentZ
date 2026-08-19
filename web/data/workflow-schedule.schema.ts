import cron from "cron-validate"
import * as z from "zod"
import { dayjs } from "@/lib/format"
import type {
  WorkflowArbitraryJson,
  WorkflowInputSchema,
  WorkflowInputs,
} from "@/lib/gateway/client"
import { zJsonValue, zWorkflowName, zWorkflowScheduleName } from "@/lib/gateway/client/zod.gen"

const workflowNameSchema = z
  .string()
  .trim()
  .min(1, "Workflow name is required")
  .max(32, "Workflow name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zWorkflowName)

export const workflowScheduleNameSchema = z
  .string()
  .trim()
  .min(1, "Schedule name is required")
  .max(32, "Schedule name must be at most 32 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens")
  .pipe(zWorkflowScheduleName)

const workflowScheduleFieldSchema = z.union(
  [
    z.string({ error: "Input value must be text" }),
    z.number({ error: "Input value must be a number" }),
    z.boolean({ error: "Input value must be true or false" }),
    z.undefined(),
  ],
  { error: "Input value must be text, a number, or true/false" }
)

export const workflowScheduleInputsSchema = z.record(
  z.string({ error: "Input name must be text" }),
  workflowScheduleFieldSchema
)
export const workflowScheduleInputTextSchema = z.codec(
  z.string({ error: "Input value must be text" }),
  workflowScheduleFieldSchema,
  {
    decode: (value, ctx) => {
      if (value === "") {
        return undefined
      }

      try {
        return JSON.parse(value)
      } catch {
        ctx.issues.push({
          code: "custom",
          input: value,
          message: "Input value must be valid JSON",
        })
        return z.NEVER
      }
    },
    encode: (value) => (value === undefined ? "" : JSON.stringify(value)),
  }
)
export const workflowScheduleArbitraryJSONSchema = z.codec(
  z.string({ error: "Input JSON must be text" }),
  zJsonValue.optional(),
  {
    decode: (value, ctx) => {
      if (value.trim() === "") {
        return undefined
      }

      try {
        return JSON.parse(value)
      } catch {
        ctx.issues.push({
          code: "custom",
          input: value,
          message: "Input must be valid JSON",
        })
        return z.NEVER
      }
    },
    encode: (value) => (value === undefined ? "" : JSON.stringify(value, null, 2)),
  }
)

export type WorkflowScheduleInputValue = string | number | boolean | undefined

export type WorkflowInputContract = {
  inputs: WorkflowInputs
  arbitrary_json?: WorkflowArbitraryJson
}

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
  time_zone: z.string({ error: "Timezone is required" }).trim().min(1, "Timezone is required"),
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
  arbitrary_json: z.string({ error: "Input JSON must be text" }),
})

export type CreateWorkflowScheduleFormValues = z.infer<typeof createWorkflowScheduleFormSchema>

export function buildWorkflowScheduleFormSchema(
  contract: WorkflowInputContract
): z.ZodType<CreateWorkflowScheduleFormValues, CreateWorkflowScheduleFormValues> {
  if (contract.arbitrary_json) {
    return createWorkflowScheduleFormSchema.extend({
      inputs: workflowScheduleInputsSchema,
      arbitrary_json: arbitraryJSONTextSchema,
    })
  }

  return createWorkflowScheduleFormSchema.extend({
    inputs: buildWorkflowInputObjectSchema(contract.inputs),
  })
}

const arbitraryJSONTextSchema = z
  .string()
  .refine(
    (value) => workflowScheduleArbitraryJSONSchema.safeDecode(value).success,
    "Input must be valid JSON"
  )

function buildWorkflowInputObjectSchema(inputSchema: WorkflowInputs) {
  return workflowScheduleInputsSchema.superRefine((values, ctx) => {
    for (const name of Object.keys(values)) {
      if (name in inputSchema) {
        continue
      }

      ctx.addIssue({
        code: "custom",
        message: "Unrecognized input",
        path: [name],
      })
    }

    for (const [name, input] of Object.entries(inputSchema)) {
      const schema = input.required
        ? buildWorkflowInputValueSchema(name, input)
        : buildWorkflowInputValueSchema(name, input).optional()
      const result = schema.safeParse(values[name])
      if (result.success) {
        continue
      }

      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: [name, ...issue.path],
        })
      }
    }
  })
}

export function workflowInputDefaultValues(inputSchema: WorkflowInputs) {
  const values: Record<string, WorkflowScheduleInputValue> = {}

  for (const [name, input] of Object.entries(inputSchema)) {
    values[name] = input.default
  }

  return values
}

function buildWorkflowInputValueSchema(name: string, input: WorkflowInputSchema) {
  let schema: z.ZodType<Exclude<WorkflowScheduleInputValue, undefined>>
  const label = input.description ?? name

  switch (input.type) {
    case "boolean":
      schema = z.boolean({
        error: (issue) =>
          issue.input === undefined ? `${label} is required` : `${label} must be true or false`,
      })
      break
    case "integer":
      schema = buildWorkflowNumberSchema(label, input, true)
      break
    case "number":
      schema = buildWorkflowNumberSchema(label, input, false)
      break
    case "string":
      schema = buildWorkflowStringSchema(label, input)
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

function buildWorkflowStringSchema(label: string, input: WorkflowInputSchema) {
  let schema = z.string({
    error: (issue) =>
      issue.input === undefined ? `${label} is required` : `${label} must be text`,
  })

  if (input.minLength !== undefined) {
    schema = schema.min(input.minLength, `${label} must be at least ${input.minLength} characters`)
  }
  if (input.maxLength !== undefined) {
    schema = schema.max(input.maxLength, `${label} must be at most ${input.maxLength} characters`)
  }
  if (input.pattern !== undefined) {
    schema = schema.regex(new RegExp(input.pattern), `${label} does not match the required pattern`)
  }

  switch (input.format) {
    case "date":
      schema = schema.refine((value) => dateStringPattern.test(value), {
        message: `${label} must be a valid date`,
      })
      break
    case "date-time":
      schema = schema.refine((value) => dayjs(value).isValid(), {
        message: `${label} must be a valid date and time`,
      })
      break
    case "email":
      schema = schema.email(`${label} must be a valid email address`)
      break
    case "uri":
      schema = schema.url(`${label} must be a valid URL`)
      break
    case "uuid":
      schema = schema.uuid(`${label} must be a valid UUID`)
      break
    case undefined:
      break
  }

  return schema
}

function buildWorkflowNumberSchema(label: string, input: WorkflowInputSchema, integer: boolean) {
  let schema = integer
    ? z.int({
        error: (issue) =>
          issue.input === undefined ? `${label} is required` : `${label} must be a whole number`,
      })
    : z.number({
        error: (issue) =>
          issue.input === undefined ? `${label} is required` : `${label} must be a number`,
      })

  if (input.minimum !== undefined) {
    schema = schema.gte(input.minimum, `${label} must be at least ${input.minimum}`)
  }
  if (input.maximum !== undefined) {
    schema = schema.lte(input.maximum, `${label} must be at most ${input.maximum}`)
  }
  if (input.exclusiveMinimum !== undefined) {
    schema = schema.gt(
      input.exclusiveMinimum,
      `${label} must be greater than ${input.exclusiveMinimum}`
    )
  }
  if (input.exclusiveMaximum !== undefined) {
    schema = schema.lt(
      input.exclusiveMaximum,
      `${label} must be less than ${input.exclusiveMaximum}`
    )
  }
  if (input.multipleOf !== undefined) {
    schema = schema.multipleOf(
      input.multipleOf,
      `${label} must be a multiple of ${input.multipleOf}`
    )
  }

  return schema
}

const dateStringPattern = /^\d{4}-\d{2}-\d{2}$/
