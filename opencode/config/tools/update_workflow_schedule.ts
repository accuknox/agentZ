import { tool } from "@opencode-ai/plugin"

import { type UpdateWorkflowScheduleRequest, updateWorkflowSchedule, zError } from "../lib/gateway"
import { zUpdateWorkflowScheduleBody } from "../lib/gateway/client/zod.gen"
import {
  formatScheduleRequestValidationError,
  jsonValueSchema,
  validateWorkflowScheduleInputs,
} from "../lib/workflow_schedule"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

const args = {
  name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("WorkflowSchedule resource name to update."),
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("Saved workflow name this schedule should run after the update."),
  schedule: tool.schema
    .string()
    .min(1)
    .describe("Full replacement cron expression for when the workflow should run."),
  inputs: tool.schema
    .record(tool.schema.string(), jsonValueSchema)
    .describe(
      "Full replacement JSON object of runtime workflow inputs. " +
        "Match the saved workflow input schema exactly. " +
        "Use {} when the workflow takes no inputs."
    ),
  timeout_seconds: tool.schema
    .number()
    .int()
    .min(1)
    .max(604800)
    .describe(
      "Full replacement maximum runtime in seconds before the scheduled workflow run times out."
    ),
}

const description = `
Update a workflow schedule.

Use this tool when the user wants to change an existing saved schedule.

Authoring rules:
- name identifies the existing schedule to replace.
- workflow_name, schedule, inputs, and timeout_seconds are full replacements and must all be provided together.
- inputs must be a JSON object of runtime values, not an input schema definition.
- If the workflow has no inputs, pass {}.
`.trim()

export default tool({
  description,
  args,
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      context.metadata({
        title: "Workflow schedule update unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "CLAWARMOR_AGENT_NAME is not set. Configure the agent runtime before using update_workflow_schedule."
    }

    context.metadata({
      title: `Update workflow schedule ${args.name}`,
      metadata: {
        agent_name: agentName,
        name: args.name,
        workflow_name: args.workflow_name,
      },
    })

    const bodyInput = {
      schedule: args.schedule.trim(),
      inputs: args.inputs,
      timeout_seconds: args.timeout_seconds,
    }

    const validation = await validateWorkflowScheduleInputs(
      agentName,
      args.workflow_name,
      args.inputs
    )
    if (validation) {
      context.metadata({
        title: "Workflow schedule update failed",
        metadata: {
          agent_name: agentName,
          name: args.name,
          workflow_name: args.workflow_name,
          ...validation.metadata,
        },
      })
      return validation.message
    }

    const bodyResult = zUpdateWorkflowScheduleBody.safeParse(bodyInput)
    if (!bodyResult.success) {
      context.metadata({
        title: "Workflow schedule update failed",
        metadata: {
          agent_name: agentName,
          name: args.name,
          reason: "invalid_request_body",
          issues: bodyResult.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      })
      return formatScheduleRequestValidationError(bodyResult.error.issues)
    }

    const body: UpdateWorkflowScheduleRequest = bodyResult.data

    const result = await updateWorkflowSchedule({
      path: {
        agentName,
        workflowName: args.workflow_name,
        scheduleName: args.name,
      },
      body,
      throwOnError: false,
    })
    if (result.data) {
      context.metadata({
        title: `Workflow schedule ${result.data.name} updated`,
        metadata: {
          agent_name: result.data.agent_name,
          name: result.data.name,
          workflow_name: result.data.workflow_name,
        },
      })
      return (
        `Updated workflow schedule ${result.data.name} for agent ` +
        `${result.data.agent_name}. It now runs workflow ` +
        `${result.data.workflow_name} on schedule ${result.data.schedule}.`
      )
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow schedule update failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return (
        `Workflow schedule update failed for agent ${agentName}, and the ` +
        "service returned an unexpected error shape."
      )
    }

    context.metadata({
      title: "Workflow schedule update failed",
      metadata: {
        agent_name: agentName,
        name: args.name,
        workflow_name: args.workflow_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return workflowErrorOutput(error.data)
  },
})
