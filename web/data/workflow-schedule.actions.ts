"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import * as z from "zod"
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  getWorkflow,
  type JsonValue,
  updateWorkflowSchedule,
} from "@/lib/gateway/client"
import { agentWorkflowsTag, workflowsTag } from "@/data/cache"
import {
  buildWorkflowScheduleFormSchema,
  type CreateWorkflowScheduleFormValues,
  workflowScheduleNameSchema,
} from "@/data/workflow-schedule.schema"
import type {
  CreateWorkflowScheduleFormState,
  DeleteWorkflowScheduleFormState,
  UpdateWorkflowScheduleFormState,
  WorkflowInputSchemaResult,
} from "@/data/types"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

type ParsedScheduleForm = {
  data: CreateWorkflowScheduleFormValues
  inputs: JsonValue
}

type WorkflowScheduleInputsJSON = Record<string, string | number | boolean>

const scheduleFormDataSchema = z.object({
  name: workflowScheduleNameSchema,
  workflow_name: z.string().min(1, "Workflow is required"),
  schedule: z.string(),
  time_zone: z.string(),
  timeout_seconds: z.coerce.number(),
  successful_runs_history_limit: z.coerce.number(),
  failed_runs_history_limit: z.coerce.number(),
})

const workflowScheduleInputJSONSchema = z.union([z.string(), z.number(), z.boolean()])

export async function createWorkflowScheduleFormAction(
  agentName: string,
  _: CreateWorkflowScheduleFormState,
  formData: FormData
): Promise<CreateWorkflowScheduleFormState> {
  const parsed = await parseScheduleForm(agentName, formData)
  if ("error" in parsed) {
    return parsed
  }

  const result = await createWorkflowSchedule({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName: parsed.data.workflow_name,
    },
    body: {
      name: parsed.data.name,
      schedule: parsed.data.schedule,
      time_zone: parsed.data.time_zone,
      timeout_seconds: parsed.data.timeout_seconds,
      successful_runs_history_limit: parsed.data.successful_runs_history_limit,
      failed_runs_history_limit: parsed.data.failed_runs_history_limit,
      inputs: parsed.inputs,
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  finishWorkflowScheduleMutation(agentName)
}

export async function getWorkflowInputSchemaAction(
  agentName: string,
  workflowName: string
): Promise<WorkflowInputSchemaResult> {
  const result = await getWorkflow({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName,
    },
  })
  if (result.error) {
    return {
      ok: false,
      error: result.error,
    }
  }

  return {
    ok: true,
    inputs: result.data.inputs ?? {},
  }
}

export async function updateWorkflowScheduleFormAction(
  agentName: string,
  _: UpdateWorkflowScheduleFormState,
  formData: FormData
): Promise<UpdateWorkflowScheduleFormState> {
  const nameResult = scheduleFormDataSchema
    .pick({ name: true })
    .safeParse(Object.fromEntries(formData))
  if (!nameResult.success) {
    return invalidFormState("Schedule configuration is invalid", nameResult.error.issues)
  }

  const parsed = await parseScheduleForm(agentName, formData)
  if ("error" in parsed) {
    return parsed
  }

  const result = await updateWorkflowSchedule({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName: parsed.data.workflow_name,
      scheduleName: nameResult.data.name,
    },
    body: {
      schedule: parsed.data.schedule,
      time_zone: parsed.data.time_zone,
      timeout_seconds: parsed.data.timeout_seconds,
      successful_runs_history_limit: parsed.data.successful_runs_history_limit,
      failed_runs_history_limit: parsed.data.failed_runs_history_limit,
      inputs: parsed.inputs,
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  finishWorkflowScheduleMutation(agentName)
}

export async function deleteWorkflowScheduleFormAction(
  agentName: string,
  _: DeleteWorkflowScheduleFormState,
  formData: FormData
): Promise<DeleteWorkflowScheduleFormState> {
  const parsed = scheduleFormDataSchema
    .pick({ name: true, workflow_name: true })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return invalidFormState("Invalid schedule", parsed.error.issues)
  }

  const result = await deleteWorkflowSchedule({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName: parsed.data.workflow_name,
      scheduleName: parsed.data.name,
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  finishWorkflowScheduleMutation(agentName)
}

async function parseScheduleForm(agentName: string, formData: FormData) {
  const scalarValues = scheduleFormDataSchema.safeParse(Object.fromEntries(formData))
  if (!scalarValues.success) {
    return invalidFormState("Schedule configuration is invalid", scalarValues.error.issues)
  }

  const values: CreateWorkflowScheduleFormValues = {
    ...scalarValues.data,
    inputs: {},
  }

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("input:")) {
      continue
    }

    const name = key.slice("input:".length)
    const inputValue = z.string().safeParse(value)
    if (!inputValue.success) {
      return invalidFormState("Schedule configuration is invalid", inputValue.error.issues)
    }

    if (inputValue.data.length === 0) {
      values.inputs[name] = undefined
      continue
    }

    try {
      const parsedInput = workflowScheduleInputJSONSchema.safeParse(JSON.parse(inputValue.data))
      if (!parsedInput.success) {
        return invalidFormState("Schedule configuration is invalid", parsedInput.error.issues)
      }

      values.inputs[name] = parsedInput.data
    } catch {
      return invalidFormState("Schedule configuration is invalid", [
        {
          code: "custom",
          message: "Input value is invalid",
          path: [name],
        },
      ])
    }
  }

  const workflowResult = await getWorkflow({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName: values.workflow_name,
    },
  })
  if (workflowResult.error) {
    return { error: workflowResult.error }
  }

  const parsed = buildWorkflowScheduleFormSchema(workflowResult.data.inputs ?? {}).safeParse(values)
  if (!parsed.success) {
    return invalidFormState("Schedule configuration is invalid", parsed.error.issues)
  }

  return {
    data: parsed.data,
    inputs: workflowScheduleInputsToJSON(parsed.data.inputs),
  } satisfies ParsedScheduleForm
}

function finishWorkflowScheduleMutation(agentName: string): never {
  updateTag(workflowsTag)
  updateTag(agentWorkflowsTag(agentName))
  redirect(`/workflows/triggers?agent_name=${encodeURIComponent(agentName)}&type=schedule`)
}

function invalidFormState(message: string, issues: z.ZodIssue[], field?: string) {
  return {
    error: {
      code: "INVALID_FORM",
      message,
      errors: issues.map((issue) => ({
        field: field ?? issue.path.join("."),
        message: issue.message,
      })),
    },
  }
}

function workflowScheduleInputsToJSON(
  inputs: CreateWorkflowScheduleFormValues["inputs"]
): WorkflowScheduleInputsJSON {
  const jsonInputs: WorkflowScheduleInputsJSON = {}

  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined) {
      continue
    }

    jsonInputs[name] = value
  }

  return jsonInputs
}
