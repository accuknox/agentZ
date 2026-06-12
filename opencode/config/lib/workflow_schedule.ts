import { tool } from "@opencode-ai/plugin"

import { getWorkflow, listAgentWorkflowSchedules, zError } from "./gateway"
import { formatRequestValidationError, workflowErrorOutput } from "./workflow"
import {
  formatWorkflowInputValidationError,
  validateWorkflowRuntimeInputs,
} from "./workflow_inputs"

export const jsonValueSchema = buildJSONValueSchema()

export async function validateWorkflowScheduleInputs(
  agentName: string,
  workflowName: string,
  inputs: unknown
) {
  const workflow = await getWorkflow({
    path: {
      agentName,
      workflowName,
    },
    throwOnError: false,
  })
  if (!workflow.data) {
    const error = zError.safeParse(workflow.error)
    if (!error.success) {
      return {
        message:
          `Workflow retrieval failed for agent ${agentName}, and the service ` +
          "returned an unexpected error shape.",
        metadata: {
          reason: "workflow_lookup_failed",
          code: "unexpected_error",
        },
      }
    }

    if (error.data.code === "not_found") {
      return {
        message:
          `Workflow ${workflowName} was not found for agent ${agentName}. ` +
          "Create it first or verify the workflow_name before retrying.",
        metadata: {
          reason: "workflow_lookup_failed",
          code: error.data.code,
        },
      }
    }

    return {
      message: workflowErrorOutput(error.data),
      metadata: {
        reason: "workflow_lookup_failed",
        code: error.data.code,
      },
    }
  }

  const issues = validateWorkflowRuntimeInputs(inputs, workflow.data.inputs)
  if (issues.length === 0) {
    return null
  }

  return {
    message: formatWorkflowInputValidationError(issues),
    metadata: {
      reason: "invalid_workflow_inputs",
      issues,
    },
  }
}

export function formatScheduleRequestValidationError(
  issues: Array<{ path: PropertyKey[]; message: string }>
) {
  return formatRequestValidationError(
    "Workflow schedule request validation failed.",
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "request",
      message: issue.message,
    }))
  )
}

export async function listWorkflowSchedulesOnce(agentName: string, scheduleName: string) {
  const result = await listAgentWorkflowSchedules({
    path: {
      agentName,
    },
    query: {
      limit: 200,
    },
    throwOnError: false,
  })
  if (!result.data) {
    const error = zError.safeParse(result.error)
    if (!error.success) {
      return {
        ok: false as const,
        message:
          `Workflow schedule lookup failed for agent ${agentName}, and the ` +
          "service returned an unexpected error shape.",
        metadata: {
          reason: "workflow_schedule_lookup_failed",
          code: "unexpected_error",
        },
      }
    }

    return {
      ok: false as const,
      message: workflowErrorOutput(error.data),
      metadata: {
        reason: "workflow_schedule_lookup_failed",
        code: error.data.code,
      },
    }
  }

  const schedule = result.data.workflow_schedules.find(
    (item: (typeof result.data.workflow_schedules)[number]) => item.name === scheduleName
  )
  if (!schedule) {
    return {
      ok: false as const,
      message: `Workflow schedule ${scheduleName} was not found for agent ${agentName}.`,
      metadata: {
        reason: "workflow_schedule_lookup_failed",
        code: "not_found",
      },
    }
  }

  return {
    ok: true as const,
    value: schedule,
  }
}

function buildJSONValueSchema() {
  let schema: ReturnType<typeof tool.schema.lazy>
  schema = tool.schema.lazy(() =>
    tool.schema.union([
      tool.schema.boolean(),
      tool.schema.number(),
      tool.schema.string(),
      tool.schema.array(schema),
      tool.schema.record(tool.schema.string(), schema),
    ])
  )
  return schema
}
