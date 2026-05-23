import { tool } from "@opencode-ai/plugin"

import { listWorkflowSummaries } from "../lib/gateway"
import { zError } from "../lib/gateway"
import { agentNameFromResourceAttributes, workflowErrorOutput } from "../lib/workflow"

const description = `
List all persisted ClawArmor workflows for the current agent.

Use this tool when you need to discover which saved workflows already exist
before choosing one to inspect, update, or delete. This tool lists every
saved workflow for the current agent and returns only the workflow name,
title, and summary metadata.

Do not use this tool when you need the full workflow graph, nodes, edges, or
execution playbook. Use get_workflow for that.

Examples:
If the user asks "show me all saved workflows for this agent", call this tool
with no arguments.

If the user asks "what workflows do we already have before I pick one to
edit?", call this tool with no arguments.
`.trim()

export default tool({
  description,
  args: {},
  async execute(_, context) {
    const agentName = agentNameFromResourceAttributes(process.env.OPENCODE_RESOURCE_ATTRIBUTES)
    if (!agentName) {
      context.metadata({
        title: "Workflow listing unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "Could not derive clawarmor.agent_name from OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject that resource attribute before using list_workflows."
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
