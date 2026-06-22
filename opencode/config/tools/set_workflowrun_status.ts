import { tool } from "@opencode-ai/plugin"

import { patchWorkflowRunStatus, type PatchWorkflowRunStatusRequest, zError } from "../lib/gateway"
import { workflowAgentName } from "../lib/workflow"

const args = {
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .describe("Workflow resource name that owns this workflow run."),
  workflowrun_name: tool.schema
    .string()
    .min(1)
    .max(253)
    .describe("WorkflowRun resource name to update."),
  phase: tool.schema.enum(["Succeeded", "Failed"]).describe("Terminal WorkflowRun phase."),
  message: tool.schema
    .string()
    .max(4096)
    .optional()
    .describe("Optional terminal summary or failure reason."),
}

export default tool({
  description: [
    "Set the terminal status for WorkflowRun.",
    "Use this only after the workflow has fully finished.",
    "This tool only permits terminal phases: Succeeded or Failed.",
    "It is mandatory to run this tool as soon as you finish executing the workflow.",
  ].join(" "),
  args,
  async execute(input, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      return "CLAWARMOR_AGENT_NAME is not set. Configure the agent runtime before using set_workflowrun_status."
    }

    context.metadata({
      title: `Set workflow run ${input.phase.toLowerCase()}`,
      metadata: {
        agent_name: agentName,
        workflow_name: input.workflow_name,
        workflowrun_name: input.workflowrun_name,
        phase: input.phase,
      },
    })

    try {
      const body = {
        phase: input.phase,
        message: input.message,
      } satisfies PatchWorkflowRunStatusRequest
      const result = await patchWorkflowRunStatus({
        path: {
          agentName,
          workflowName: input.workflow_name,
          runName: input.workflowrun_name,
        },
        body,
        throwOnError: false,
      })
      if (!result.error) {
        return `workflow run ${input.workflowrun_name} marked ${input.phase.toLowerCase()}`
      }

      const error = zError.safeParse(result.error)
      if (error.success) {
        return `workflow run status update failed: ${error.data.code}: ${error.data.message}`
      }

      return "workflow run status update failed: unexpected gateway error"
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown gateway client error"
      return `workflow run status update failed: ${message}`
    }
  },
})
