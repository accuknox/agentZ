import { z, ZodError } from "zod"

import type { Workflow, WorkflowInputSchema, WorkflowInputs } from "./gateway/client"
import { zJsonValue } from "./gateway/client/zod.gen"

export type WorkflowInputValidationIssue = {
  path: string
  message: string
}

export function validateWorkflowRuntimeInputs(inputs: unknown, workflow: Workflow) {
  const result = workflow.arbitrary_json
    ? zJsonValue.safeParse(inputs)
    : buildWorkflowInputsSchema(workflow.inputs).safeParse(inputs)
  if (result.success) {
    return []
  }

  return zodIssues(result.error)
}

export function formatWorkflowInputValidationError(issues: Array<WorkflowInputValidationIssue>) {
  const lines = ["Workflow schedule request validation failed."]
  for (const issue of issues) {
    lines.push(`${issue.path}: ${issue.message}`)
  }
  return lines.join("\n")
}

function buildWorkflowInputsSchema(schema: WorkflowInputs | undefined) {
  const shape: Record<string, z.ZodType<unknown>> = {}

  for (const [name, input] of Object.entries(schema ?? {})) {
    shape[name] = input.required
      ? buildWorkflowInputSchema(input)
      : buildWorkflowInputSchema(input).optional()
  }

  return z.strictObject(shape)
}

function buildWorkflowInputSchema(input: WorkflowInputSchema) {
  let schema: z.ZodType<unknown>

  switch (input.type) {
    case "string":
      schema = buildStringSchema(input)
      break
    case "integer":
      schema = buildNumberSchema(input, true)
      break
    case "number":
      schema = buildNumberSchema(input, false)
      break
    case "boolean":
      schema = z.boolean()
      break
  }

  if (input.enum && input.enum.length > 0) {
    schema = schema.refine((value) => input.enum?.some((item) => item === value) ?? false, {
      message: `must be one of ${input.enum.map((value) => JSON.stringify(value)).join(", ")}`,
    })
  }

  return schema
}

function buildStringSchema(input: WorkflowInputSchema) {
  let schema = z.string()

  if (input.minLength !== undefined) {
    schema = schema.min(input.minLength)
  }
  if (input.maxLength !== undefined) {
    schema = schema.max(input.maxLength)
  }
  if (input.pattern !== undefined) {
    schema = schema.regex(new RegExp(input.pattern))
  }

  switch (input.format) {
    case "email":
      schema = schema.email()
      break
    case "uri":
      schema = schema.url()
      break
    case "uuid":
      schema = schema.uuid()
      break
    case "date":
      schema = schema.date()
      break
    case "date-time":
      schema = schema.datetime()
      break
    case undefined:
      break
  }

  return schema
}

function buildNumberSchema(input: WorkflowInputSchema, integer: boolean) {
  let schema = integer ? z.int() : z.number()

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

function zodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `inputs.${issue.path.join(".")}` : "inputs",
    message: issue.message,
  }))
}
