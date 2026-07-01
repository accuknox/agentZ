import { tool } from "@opencode-ai/plugin"

import { listWorkflowSummaries } from "../lib/gateway"
import { zError } from "../lib/gateway"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

const description = `
List all saved workflows.

Use this tool when you need to discover which saved workflows already exist before choosing one to inspect, update, or delete. This returns the workflow name, title, and summary metadata for every saved workflow.

Do NOT use this tool when you need the full workflow graph, nodes, edges, or execution playbook. Use get_workflow for that.

This tool takes no arguments.
`.trim()

export default tool({
  description,
  args: {},
  async execute(_, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      context.metadata({
        title: "Workflow listing unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before using list_workflows."
    }

    context.metadata({
      title: `List workflows for ${agentName}`,
      metadata: {
        agent_name: agentName,
      },
    })

    const result = await listWorkflowSummaries({
      path: {
        agentName,
      },
      throwOnError: false,
    })
    if (result.data) {
      context.metadata({
        title: `Listed workflows for ${agentName}`,
        metadata: {
          agent_name: agentName,
          workflow_count: result.data.length,
        },
      })

      if (result.data.length === 0) {
        return `No saved workflows exist for agent ${agentName}.`
      }

      return result.data
        .map(
          (workflow) =>
            `- name: ${workflow.workflow_name}, title: ${workflow.title}, summary: ${workflow.summary}`
        )
        .join("\n")
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow listing failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return `Workflow listing failed for agent ${agentName}, and the service returned an unexpected error shape.`
    }

    context.metadata({
      title: "Workflow listing failed",
      metadata: {
        agent_name: agentName,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return workflowErrorOutput(error.data)
  },
})
