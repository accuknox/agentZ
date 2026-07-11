import { z } from "zod"

import { getWorkflow, listAgentWorkflowSchedules, zError } from "./gateway"
import { zJsonValue } from "./gateway/client/zod.gen"
import { formatRequestValidationError, workflowErrorOutput } from "./workflow"
import {
  formatWorkflowInputValidationError,
  validateWorkflowRuntimeInputs,
} from "./workflow_inputs"

const arbitraryJSONTextSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value)
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "must be valid JSON",
      })
      return z.NEVER
    }
  })
  .pipe(zJsonValue)

export async function resolveWorkflowScheduleInputs(
  agentName: string,
  workflowName: string,
  inputs: Record<string, unknown> | undefined,
  arbitraryJSON: string | undefined
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
        error: {
          message:
            `Workflow retrieval failed for agent ${agentName}, and the service ` +
            "returned an unexpected error shape.",
          metadata: {
            reason: "workflow_lookup_failed",
            code: "unexpected_error",
          },
        },
      }
    }

    if (error.data.code === "not_found") {
      return {
        error: {
          message:
            `Workflow ${workflowName} was not found for agent ${agentName}. ` +
            "Create it first or verify the workflow_name before retrying.",
          metadata: {
            reason: "workflow_lookup_failed",
            code: error.data.code,
          },
        },
      }
    }

    return {
      error: {
        message: workflowErrorOutput(error.data),
        metadata: {
          reason: "workflow_lookup_failed",
          code: error.data.code,
        },
      },
    }
  }

  if (workflow.data.arbitrary_json) {
    if (inputs !== undefined) {
      return {
        error: {
          message:
            "Workflow schedule request validation failed.\ninputs: use arbitrary_json for this workflow",
          metadata: {
            reason: "invalid_workflow_inputs",
          },
        },
      }
    }

    const result = arbitraryJSONTextSchema.safeParse(arbitraryJSON ?? "{}")
    if (result.success) {
      return { value: result.data }
    }

    const issues = result.error.issues.map((issue) => ({
      path: "arbitrary_json",
      message: issue.message,
    }))
    return {
      error: {
        message: formatWorkflowInputValidationError(issues),
        metadata: {
          reason: "invalid_workflow_inputs",
          issues,
        },
      },
    }
  }

  if (arbitraryJSON !== undefined) {
    return {
      error: {
        message:
          "Workflow schedule request validation failed.\narbitrary_json: use inputs for this workflow",
        metadata: {
          reason: "invalid_workflow_inputs",
        },
      },
    }
  }

  const value = inputs ?? {}
  const issues = validateWorkflowRuntimeInputs(value, workflow.data)
  if (issues.length === 0) {
    return { value }
  }

  return {
    error: {
      message: formatWorkflowInputValidationError(issues),
      metadata: {
        reason: "invalid_workflow_inputs",
        issues,
      },
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
