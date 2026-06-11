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
import { gatewayServerClient } from "@/lib/gateway/server-client"

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
    client: gatewayServerClient,
    body: createWorkflowScheduleRequest(agentName, parsed),
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
    client: gatewayServerClient,
    path: {
      agentName,
      workflowName,
    },
    cache: "no-store",
  })
  if (result.error) {
    throw new Error(result.error.message)
  }

  return {
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
    client: gatewayServerClient,
    path: {
      agentName,
      name: nameResult.data,
    },
    body: {
      workflow_name: parsed.data.workflow_name,
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
  if (!nameResult.success) {
    return invalidFormState("Invalid schedule name", nameResult.error.issues, "name")
  }

  const result = await deleteWorkflowSchedule({
    client: gatewayServerClient,
    path: {
      agentName,
      name: nameResult.data,
    },
  })
  if (result.error) {
    return { error: result.error }
  }

  finishWorkflowScheduleMutation(agentName)
}

async function parseScheduleForm(agentName: string, formData: FormData) {
  const values: CreateWorkflowScheduleFormValues = {
    name: stringFormValue(formData.get("name")),
    workflow_name: stringFormValue(formData.get("workflow_name")),
    schedule: stringFormValue(formData.get("schedule")),
    time_zone: stringFormValue(formData.get("time_zone")),
    timeout_seconds: numberFormValue(formData.get("timeout_seconds")),
    successful_runs_history_limit: numberFormValue(formData.get("successful_runs_history_limit")),
    failed_runs_history_limit: numberFormValue(formData.get("failed_runs_history_limit")),
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

    const parsed = parseWorkflowScheduleInputValue(value)
    if (!parsed.success) {
      return invalidFormState("Schedule configuration is invalid", parsed.error.issues)
    }

    values.inputs[name] = parsed.data
  }

  const workflowResult = await getWorkflow({
    client: gatewayServerClient,
    path: {
      agentName,
      workflowName: values.workflow_name,
    },
    cache: "no-store",
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

function createWorkflowScheduleRequest(agentName: string, parsed: ParsedScheduleForm) {
  return {
    agent_name: agentName,
    name: parsed.data.name,
    workflow_name: parsed.data.workflow_name,
    schedule: parsed.data.schedule,
    time_zone: parsed.data.time_zone,
    timeout_seconds: parsed.data.timeout_seconds,
    successful_runs_history_limit: parsed.data.successful_runs_history_limit,
    failed_runs_history_limit: parsed.data.failed_runs_history_limit,
    inputs: parsed.inputs,
  }
}

function finishWorkflowScheduleMutation(agentName: string): never {
  updateTag(workflowsTag)
  updateTag(agentWorkflowsTag(agentName))
  redirect(`/workflows/schedules?agent_name=${encodeURIComponent(agentName)}`)
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

function parseWorkflowScheduleInputValue(value: string) {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    return z.never().safeParse(parsed)
  }

  return z.union([z.string(), z.number(), z.boolean()]).safeParse(parsed)
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

function stringFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : ""
}

function numberFormValue(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return Number.NaN
  }

  return Number(value)
}
