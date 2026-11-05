import { tool } from "@opencode-ai/plugin"

import { createWorkflowSchedule, type CreateWorkflowScheduleRequest, zError } from "../lib/gateway"
import { zCreateWorkflowScheduleBody } from "../lib/gateway/client/zod.gen"
import {
  formatScheduleRequestValidationError,
  resolveWorkflowScheduleInputs,
} from "../lib/workflow_schedule"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

const args = {
  subscribe: tool.schema
    .boolean()
    .optional()
    .describe("Return each run result to this conversation for review. Defaults to false."),
  name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("WorkflowSchedule resource name. Use a stable DNS label such as nightly-triage."),
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("Saved workflow name this schedule should run."),
  schedule: tool.schema
    .string()
    .min(1)
    .describe("Cron expression for when the workflow should run."),
  inputs: tool.schema
    .record(tool.schema.string(), tool.schema.unknown())
    .optional()
    .describe(
      "Runtime input object for a typed-input workflow. Omit this for workflows without inputs. Do not use it for arbitrary_json workflows."
    ),
  arbitrary_json: tool.schema
    .string()
    .optional()
    .describe(
      'JSON-encoded runtime input for an arbitrary_json workflow, for example {"message":"hello","tags":["a","b"],"count":42}. Do not use it for typed-input workflows.'
    ),
  timeout_seconds: tool.schema
    .number()
    .int()
    .min(1)
    .max(604800)
    .describe("Maximum runtime in seconds before the scheduled workflow run times out."),
}

const description = `
Create a workflow schedule.

Call the workflow-scheduler skill before creating a schedule or choosing its conversation delivery.
Successful calls save a cron schedule that runs the saved workflow automatically.
`.trim()

export default tool({
  description,
  args,
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      context.metadata({
        title: "Workflow schedule creation unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before using create_workflow_schedule."
    }

    context.metadata({
      title: `Create workflow schedule ${args.name}`,
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
        title: "Workflow schedule creation failed",
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
      context_session_id: args.subscribe ? context.sessionID : undefined,
      name: args.name,
      schedule: args.schedule.trim(),
      inputs: resolved.value,
      timeout_seconds: args.timeout_seconds,
      successful_runs_history_limit: 3,
      failed_runs_history_limit: 3,
    }

    const bodyResult = zCreateWorkflowScheduleBody.safeParse(bodyInput)
    if (!bodyResult.success) {
      context.metadata({
        title: "Workflow schedule creation failed",
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

    const body: CreateWorkflowScheduleRequest = bodyResult.data

    const result = await createWorkflowSchedule({
      path: {
        agentName,
        workflowName: args.workflow_name,
      },
      body,
      throwOnError: false,
    })
    if (result.data) {
      context.metadata({
        title: `Workflow schedule ${result.data.name} created`,
        metadata: {
          agent_name: result.data.agent_name,
          name: result.data.name,
          workflow_name: result.data.workflow_name,
        },
      })
      return (
        `Created workflow schedule ${result.data.name} for agent ` +
        `${result.data.agent_name}. It will run workflow ` +
        `${result.data.workflow_name} on schedule ${result.data.schedule}.` +
        (result.data.delivery
          ? " This conversation will receive each run result. Deleting the schedule stops future runs and notifications."
          : "")
      )
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow schedule creation failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return (
        `Workflow schedule creation failed for agent ${agentName}, and the ` +
        "service returned an unexpected error shape."
      )
    }

    context.metadata({
      title: "Workflow schedule creation failed",
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
