import { tool } from "@opencode-ai/plugin"

import { type UpdateWorkflowScheduleRequest, updateWorkflowSchedule, zError } from "../lib/gateway"
import { zUpdateWorkflowScheduleBody } from "../lib/gateway/client/zod.gen"
import {
  formatScheduleRequestValidationError,
  resolveWorkflowScheduleInputs,
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
    .record(tool.schema.string(), tool.schema.unknown())
    .optional()
    .describe(
      "Full replacement runtime input object for a typed-input workflow. Omit this for workflows without inputs. Do not use it for arbitrary_json workflows."
    ),
  arbitrary_json: tool.schema
    .string()
    .optional()
    .describe(
      'Full replacement JSON-encoded runtime input for an arbitrary_json workflow, for example {"message":"hello","tags":["a","b"],"count":42}. Do not use it for typed-input workflows.'
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
- workflow_name, schedule, and timeout_seconds are full replacements and must all be provided together.
- For a typed-input workflow, pass runtime values in inputs.
- For an arbitrary_json workflow, pass one JSON-encoded value in arbitrary_json.
- Never pass both inputs and arbitrary_json.
- If the workflow has no inputs, omit inputs or pass {}.
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
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before using update_workflow_schedule."
    }

    context.metadata({
      title: `Update workflow schedule ${args.name}`,
      metadata: {
        agent_name: agentName,
        name: args.name,
        workflow_name: args.workflow_name,
      },
    })

    const resolved = await resolveWorkflowScheduleInputs(
      agentName,
      args.workflow_name,
      args.inputs,
      args.arbitrary_json
    )
    if (resolved.error) {
      context.metadata({
        title: "Workflow schedule update failed",
        metadata: {
          agent_name: agentName,
          name: args.name,
          workflow_name: args.workflow_name,
          ...resolved.error.metadata,
        },
      })
      return resolved.error.message
    }

    const bodyInput = {
      schedule: args.schedule.trim(),
      inputs: resolved.value,
      timeout_seconds: args.timeout_seconds,
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
