import { tool } from "@opencode-ai/plugin"

import {
  patchWorkflowRunNodeStatus,
  patchWorkflowRunStatus,
  type PatchWorkflowRunNodeStatusRequest,
  type PatchWorkflowRunStatusRequest,
  zError,
} from "../lib/gateway"
import { workflowAgentName } from "../lib/workflow"

const args = {
  mode: tool.schema
    .enum(["run", "node"])
    .describe(
      "Use node before and after each step. Use run exactly once when the whole workflow finishes."
    ),
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
  node_name: tool.schema
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Workflow node name. Required when mode is node."),
  phase: tool.schema
    .enum(["Running", "Succeeded", "Failed"])
    .describe("Node phase for mode node. Terminal WorkflowRun phase for mode run."),
  message: tool.schema
    .string()
    .max(4096)
    .optional()
    .describe("Optional terminal summary or failure reason."),
}

export default tool({
  description: [
    "Set WorkflowRun or workflow node status.",
    'Use mode "node" with phase "Running" before starting each node.',
    'Use mode "node" with phase "Succeeded" or "Failed" immediately after finishing each node.',
    'Use mode "run" exactly once after the full workflow finishes; mode "run" only permits Succeeded or Failed.',
  ].join(" "),
  args,
  async execute(input, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before using set_workflowrun_status."
    }

    context.metadata({
      title:
        input.mode === "node"
          ? `Set workflow node ${input.phase.toLowerCase()}`
          : `Set workflow run ${input.phase.toLowerCase()}`,
      metadata: {
        agent_name: agentName,
        workflow_name: input.workflow_name,
        workflowrun_name: input.workflowrun_name,
        node_name: input.node_name,
        mode: input.mode,
        phase: input.phase,
      },
    })

    try {
      if (input.mode === "node") {
        if (!input.node_name) {
          return "workflow run node status update failed: node_name is required when mode is node"
        }

        const body = {
          phase: input.phase,
          message: input.message,
        } satisfies PatchWorkflowRunNodeStatusRequest
        const result = await patchWorkflowRunNodeStatus({
          path: {
            agentName,
            workflowName: input.workflow_name,
            runName: input.workflowrun_name,
            nodeName: input.node_name,
          },
          body,
          throwOnError: false,
        })
        if (!result.error) {
          return (
            `workflow run ${input.workflowrun_name} node ${input.node_name} ` +
            `marked ${input.phase.toLowerCase()}`
          )
        }

        const error = zError.safeParse(result.error)
        if (error.success) {
          return `workflow run node status update failed: ${error.data.code}: ${error.data.message}`
        }

        return "workflow run node status update failed: unexpected gateway error"
      }

      if (input.phase === "Running") {
        return 'workflow run status update failed: mode "run" only permits Succeeded or Failed'
      }

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
    } catch {
      return "workflow run status update failed: gateway client request failed"
    }
  },
})
