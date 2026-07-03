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
  const nameResult = workflowScheduleNameSchema.safeParse(formData.get("name"))
  if (!nameResult.success) {
    return invalidFormState("Schedule configuration is invalid", nameResult.error.issues, "name")
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
      scheduleName: nameResult.data,
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
  const nameResult = workflowScheduleNameSchema.safeParse(formData.get("name"))
  const workflowName = formData.get("workflow_name")
  if (!nameResult.success) {
    return invalidFormState("Invalid schedule name", nameResult.error.issues, "name")
  }

  const result = await deleteWorkflowSchedule({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName: typeof workflowName === "string" ? workflowName : "",
      scheduleName: nameResult.data,
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  finishWorkflowScheduleMutation(agentName)
}

async function parseScheduleForm(agentName: string, formData: FormData) {
  const name = formData.get("name")
  const workflowName = formData.get("workflow_name")
  const schedule = formData.get("schedule")
  const timeZone = formData.get("time_zone")
  const timeoutSeconds = formData.get("timeout_seconds")
  const successfulRunsHistoryLimit = formData.get("successful_runs_history_limit")
  const failedRunsHistoryLimit = formData.get("failed_runs_history_limit")
  const values: CreateWorkflowScheduleFormValues = {
    name: typeof name === "string" ? name : "",
    workflow_name: typeof workflowName === "string" ? workflowName : "",
    schedule: typeof schedule === "string" ? schedule : "",
    time_zone: typeof timeZone === "string" ? timeZone : "",
    timeout_seconds: typeof timeoutSeconds === "string" ? Number(timeoutSeconds) : Number.NaN,
    successful_runs_history_limit:
      typeof successfulRunsHistoryLimit === "string"
        ? Number(successfulRunsHistoryLimit)
        : Number.NaN,
    failed_runs_history_limit:
      typeof failedRunsHistoryLimit === "string" ? Number(failedRunsHistoryLimit) : Number.NaN,
    inputs: {},
  }

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("input:")) {
      continue
    }

    const name = key.slice("input:".length)
    if (typeof value !== "string") {
      continue
    }

    if (value.length === 0) {
      values.inputs[name] = undefined
      continue
    }

    let parsedInput: unknown

    try {
      parsedInput = JSON.parse(value)
    } catch {
      return invalidFormState("Schedule configuration is invalid", [
        {
          code: "custom",
          message: "Input value is invalid",
          path: [name],
        },
      ])
    }

    const parsed = z.union([z.string(), z.number(), z.boolean()]).safeParse(parsedInput)
    if (!parsed.success) {
      return invalidFormState("Schedule configuration is invalid", parsed.error.issues)
    }

    values.inputs[name] = parsed.data
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
